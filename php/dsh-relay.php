<?php
declare(strict_types=1);
/**
 * dsh2server —— PHP 中转服务器（参考实现）+ 内置测试 UI
 * ============================================================================
 *
 * 单文件、零依赖：既是协议服务端，也是一个可以在浏览器里点着测的调试台。
 *
 * 支持的协议：
 *   · HTTP 长轮询载体（POST {base}/events + GET {base}/inbox）—— 本文件实现
 *   · 管理接口（机器列表、下发操作、key 白名单、配对）
 *
 * 关于 WebSocket：PHP 的 `php -S` / mod_php 无法把连接升级成 WebSocket，
 * 因此本实现走协议允许的 HTTP 长轮询载体。插件的 `transport: 'auto'` 会在
 * WebSocket 升级失败后自动回退到这条路径，功能完全一致（延迟略高）。
 * 需要 WebSocket 时请用 Node 版参考实现，或 Workerman / Ratchet / Swoole。
 *
 * 运行（Windows 上 `PHP_CLI_SERVER_WORKERS` 不可用，所以默认轮询很短）：
 *     php -S 127.0.0.1:8080 dsh-relay.php
 * 然后浏览器打开 http://127.0.0.1:8080/ 使用测试 UI。
 * 用 Apache（XAMPP）挂载时并发更好，可把 DSH_RELAY_POLL_MS 调大。
 *
 * 环境变量：
 *     DSH_RELAY_BASE         API 前缀，默认 /dsh-api
 *     DSH_RELAY_KEYS         key 白名单文件，默认 <本目录>/keys.json
 *     DSH_RELAY_DATA         状态目录，默认 <本目录>/data
 *     DSH_RELAY_ADMIN_KEY    管理接口密钥；设置后管理接口需要 x-admin-key
 *     DSH_RELAY_POLL_MS      单次长轮询上限毫秒，默认 cli-server 400 / 其他 15000
 *     DSH_RELAY_EVENT_LIMIT  每台机器保留的最近事件条数，默认 300
 *
 * 说明：PHP 每次请求都是独立进程，没有跨请求内存，所以中转状态写在
 * data/state.json 里（仅"最近事件环 + 待发帧 + 待回请求"，不含会话正文以外的
 * 任何东西），并用 flock 保证并发安全。这与 Node 版参考实现的"纯内存"等价，
 * 只是把内存换成了本地临时文件；真正的生产后端应把状态放在内存/Redis 里。
 */

// ─────────────────────────────── 配置 ───────────────────────────────

const PROTOCOL_VERSION = 1;

$IS_CLI_SERVER = (PHP_SAPI === 'cli-server');

$BASE_PATH     = rtrim((string)(getenv('DSH_RELAY_BASE') ?: '/dsh-api'), '/');
$DATA_DIR      = (string)(getenv('DSH_RELAY_DATA') ?: (__DIR__ . DIRECTORY_SEPARATOR . 'data'));
$KEYS_FILE     = (string)(getenv('DSH_RELAY_KEYS') ?: (__DIR__ . DIRECTORY_SEPARATOR . 'keys.json'));
$ADMIN_KEY     = (string)(getenv('DSH_RELAY_ADMIN_KEY') ?: '');
$POLL_MAX_MS   = (int)(getenv('DSH_RELAY_POLL_MS') ?: ($IS_CLI_SERVER ? 400 : 15000));
$EVENT_LIMIT   = (int)(getenv('DSH_RELAY_EVENT_LIMIT') ?: 300);
$STATE_FILE    = $DATA_DIR . DIRECTORY_SEPARATOR . 'state.json';
$LOCK_FILE     = $DATA_DIR . DIRECTORY_SEPARATOR . 'state.lock';

@mkdir($DATA_DIR, 0700, true);
set_time_limit(0);
ignore_user_abort(false);

// ─────────────────────────── 基础工具 ───────────────────────────

/** 输出 JSON 并结束请求。 */
function jsonOut(int $status, $payload): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

/** 读取并解析 JSON 请求体（空体返回空数组）。 */
function readJsonBody(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        return [];
    }
    $parsed = json_decode($raw, true);
    return is_array($parsed) ? $parsed : [];
}

/** key 的非敏感展示形式，与插件端保持同一规则。 */
function fingerprint(string $key): string
{
    if ($key === '') {
        return '';
    }
    if (mb_strlen($key) <= 16) {
        return mb_substr($key, 0, 4) . '…';
    }
    return mb_substr($key, 0, 12) . '…' . mb_substr($key, -4);
}

/** 恒定时间比较，避免用 === 比较机密。 */
function secretEquals(string $a, string $b): bool
{
    if ($a === '' || $b === '') {
        return false;
    }
    return hash_equals($a, $b);
}

/** 从各种可能的来源取出实例 key。 */
function extractKey(?array $helloFrame, ?array $body): string
{
    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (is_string($header) && stripos($header, 'Bearer ') === 0) {
        return substr($header, 7);
    }
    $query = $_GET['key'] ?? '';
    if (is_string($query) && $query !== '') {
        return $query;
    }
    if (is_array($body) && isset($body['key']) && is_string($body['key'])) {
        return $body['key'];
    }
    if (is_array($helloFrame) && isset($helloFrame['auth']['key']) && is_string($helloFrame['auth']['key'])) {
        return $helloFrame['auth']['key'];
    }
    return '';
}

/** 管理接口鉴权：配置了 DSH_RELAY_ADMIN_KEY 就必须带 x-admin-key。 */
function requireAdmin(): void
{
    global $ADMIN_KEY;
    if ($ADMIN_KEY === '') {
        return; // 本地测试默认不设防；生产部署务必设置
    }
    $provided = $_SERVER['HTTP_X_ADMIN_KEY'] ?? ($_GET['adminKey'] ?? '');
    if (!is_string($provided) || !secretEquals($ADMIN_KEY, $provided)) {
        jsonOut(401, ['error' => ['code' => 'unauthorized', 'message' => '管理接口需要 x-admin-key']]);
    }
}

// ─────────────────────────── key 白名单 ───────────────────────────

function loadKeys(): array
{
    global $KEYS_FILE;
    if (!is_file($KEYS_FILE)) {
        return [];
    }
    $raw = file_get_contents($KEYS_FILE);
    $parsed = $raw === false ? null : json_decode($raw, true);
    $list = is_array($parsed) ? ($parsed['keys'] ?? $parsed) : [];
    $out = [];
    foreach ((is_array($list) ? $list : []) as $entry) {
        if (is_string($entry)) {
            $entry = ['key' => $entry];
        }
        if (is_array($entry) && isset($entry['key']) && is_string($entry['key']) && $entry['key'] !== '') {
            $out[] = $entry;
        }
    }
    return $out;
}

function saveKeys(array $keys): void
{
    global $KEYS_FILE;
    $payload = json_encode(['keys' => array_values($keys)], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    file_put_contents($KEYS_FILE, $payload . "\n", LOCK_EX);
    @chmod($KEYS_FILE, 0600);
}

function authorizeKey(string $key): ?array
{
    if ($key === '') {
        return null;
    }
    foreach (loadKeys() as $entry) {
        if (secretEquals((string)$entry['key'], $key)) {
            return $entry;
        }
    }
    return null;
}

// ─────────────────────────── 状态存取 ───────────────────────────

function defaultState(): array
{
    return [
        'instances'       => [],
        'pendingPairings' => [],
        'autoAccept'      => false,
        'updatedAt'       => time(),
    ];
}

function readStateUnlocked(): array
{
    global $STATE_FILE;
    if (!is_file($STATE_FILE)) {
        return defaultState();
    }
    $raw = file_get_contents($STATE_FILE);
    $parsed = $raw === false ? null : json_decode($raw, true);
    if (!is_array($parsed)) {
        return defaultState();
    }
    return array_merge(defaultState(), $parsed);
}

function writeStateUnlocked(array $state): void
{
    global $STATE_FILE;
    $state['updatedAt'] = time();
    $tmp = $STATE_FILE . '.' . getmypid() . '.tmp';
    file_put_contents($tmp, json_encode($state, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    @rename($tmp, $STATE_FILE);
}

/**
 * 在文件锁保护下读改写状态。
 *
 * @param callable $fn 形如 function (array &$state) { ... return $x; }
 * @param bool     $write 是否写回
 */
function withState(callable $fn, bool $write = true)
{
    global $LOCK_FILE;
    $fp = fopen($LOCK_FILE, 'c+b');
    if ($fp === false) {
        jsonOut(500, ['error' => ['code' => 'internal', 'message' => '无法打开状态锁文件']]);
    }
    flock($fp, $write ? LOCK_EX : LOCK_SH);
    try {
        $state = readStateUnlocked();
        $result = $fn($state);
        if ($write) {
            writeStateUnlocked($state);
        }
        return $result;
    } finally {
        flock($fp, LOCK_UN);
        fclose($fp);
    }
}

/**
 * 确保某台机器在状态里有槽位（不存在则创建），并可选刷新 key 信息。
 *
 * 注意：返回 void —— PHP 不允许对函数调用结果取引用，所以调用方拿到的是
 * `$state['instances'][$instanceId]` 这个真实数组元素。
 */
function ensureInstance(array &$state, string $instanceId, ?array $keyEntry = null): void
{
    if (!isset($state['instances'][$instanceId])) {
        $state['instances'][$instanceId] = [
            'instanceId'      => $instanceId,
            'keyFingerprint'  => $keyEntry ? fingerprint((string)$keyEntry['key']) : null,
            'label'           => $keyEntry['label'] ?? null,
            'transport'       => 'http',
            'tls'             => false,
            'connectedAt'     => time(),
            'lastSeenAt'      => time(),
            'hello'           => null,
            'capabilities'    => [],
            'subscriptions'   => ['topics' => [], 'sessions' => [], 'assistantStreams' => []],
            'events'          => [],
            'inbox'           => [],
            'responses'       => [],
            'pendingRequests' => [],
            'lastSeq'         => 0,
            'cursor'          => 0,
            'rejectedAt'      => null,
            'disconnectedAt'  => null,
        ];
    }
    if ($keyEntry) {
        $state['instances'][$instanceId]['keyFingerprint'] = fingerprint((string)$keyEntry['key']);
        $state['instances'][$instanceId]['label'] = $keyEntry['label'] ?? null;
    }
}

/** 把一帧放进某台机器的待发队列。 */
function queueFrame(array &$state, string $instanceId, array $frame): void
{
    ensureInstance($state, $instanceId);
    $instance = &$state['instances'][$instanceId];
    $instance['inbox'][] = $frame;
    // 队列上限，避免对端长期不在时无限增长
    if (count($instance['inbox']) > 500) {
        $instance['inbox'] = array_slice($instance['inbox'], -500);
    }
    $instance['cursor'] = (int)($frame['seq'] ?? $instance['cursor']);
}

/** 记录一次被拒绝的连接，供 UI 一键登记。 */
function recordPendingPairing(string $key, string $instanceId, string $reason): void
{
    withState(function (array &$state) use ($key, $instanceId, $reason) {
        if ($state['autoAccept']) {
            $keys = loadKeys();
            $keys[] = ['key' => $key, 'label' => $instanceId !== '' ? $instanceId : 'auto-accepted', 'addedAt' => date('c')];
            saveKeys($keys);
            return;
        }
        foreach ($state['pendingPairings'] as $pairing) {
            if (($pairing['key'] ?? '') === $key) {
                return;
            }
        }
        $state['pendingPairings'][] = [
            'key'        => $key,
            'fingerprint' => fingerprint($key),
            'instanceId' => $instanceId,
            'reason'     => $reason,
            'at'         => time(),
        ];
        if (count($state['pendingPairings']) > 20) {
            $state['pendingPairings'] = array_slice($state['pendingPairings'], -20);
        }
    });
}

// ─────────────────────────── 路由 ───────────────────────────

$requestPath = (string)(parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/');
$requestMethod = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));

$route = null;
if ($BASE_PATH !== '' && str_starts_with($requestPath, $BASE_PATH)) {
    $route = substr($requestPath, strlen($BASE_PATH));
    if ($route === false) {
        $route = '';
    }
    if ($route !== '' && $route[0] !== '/') {
        $route = null; // 例如 /dsh-apixxx 不应被当成 API
    }
}
$route = $route === null ? null : (rtrim($route, '/') === '' ? '/' : rtrim($route, '/'));

// 非 API 路径 → 提供测试 UI
if ($route === null) {
    if ($requestMethod !== 'GET') {
        jsonOut(405, ['error' => ['code' => 'bad_request', 'message' => '只支持 GET']]);
    }
    renderUi($BASE_PATH, $POLL_MAX_MS, $IS_CLI_SERVER, $ADMIN_KEY !== '');
    exit;
}

// ─────────────────────────── API 路由 ───────────────────────────

// GET {base}/ —— 协议信息
if ($route === '/' || $route === '') {
    jsonOut(200, [
        'name'         => 'dsh2server PHP relay',
        'protocol'     => PROTOCOL_VERSION,
        'basePath'     => $BASE_PATH,
        'carriers'     => ['http-long-poll' => true, 'websocket' => false],
        'webSocketNote' => 'PHP 无法把 HTTP 请求升级为 WebSocket；插件会自动回退到 HTTP 长轮询。',
        'endpoints'    => [
            'events'    => $BASE_PATH . '/events',
            'inbox'     => $BASE_PATH . '/inbox',
            'instances' => $BASE_PATH . '/instances',
            'keys'      => $BASE_PATH . '/keys',
        ],
        'pollMaxMs'    => $POLL_MAX_MS,
        'cliServer'    => $IS_CLI_SERVER,
        'keys'         => count(loadKeys()),
        'instances'    => count(withState(fn (array &$s) => array_keys($s['instances']), false)),
    ]);
}

// POST {base}/events —— 插件上行
if ($route === '/events' && $requestMethod === 'POST') {
    $body = readJsonBody();
    $frames = is_array($body['frames'] ?? null) ? $body['frames'] : [];
    $hello = null;
    foreach ($frames as $frame) {
        if (is_array($frame) && ($frame['type'] ?? '') === 'hello') {
            $hello = $frame;
            break;
        }
    }
    $key = extractKey($hello, $body);
    $entry = authorizeKey($key);
    if ($entry === null) {
        recordPendingPairing($key, (string)($hello['instanceId'] ?? ($body['instanceId'] ?? '')), 'unknown instance key');
        jsonOut(401, ['error' => [
            'code'    => 'unauthorized',
            'message' => '未登记的实例 key：请在测试 UI 的「配对」面板里登记这台机器',
        ]]);
    }

    $instanceId = (string)($body['instanceId'] ?? ($hello['instanceId'] ?? ($entry['instanceId'] ?? '')));
    if ($instanceId === '') {
        jsonOut(400, ['error' => ['code' => 'bad_request', 'message' => '缺少 instanceId']]);
    }

    $accepted = withState(function (array &$state) use ($frames, $instanceId, $entry, $hello) {
        ensureInstance($state, $instanceId, $entry);
        $instance = &$state['instances'][$instanceId];
        $instance['transport'] = 'http';
        $instance['tls'] = (($_SERVER['HTTPS'] ?? '') === 'on');
        $instance['lastSeenAt'] = time();
        $instance['rejectedAt'] = null;
        $instance['disconnectedAt'] = null;
        if ($hello !== null) {
            $instance['hello'] = [
                'v'            => $hello['v'] ?? null,
                'instance'     => $hello['instance'] ?? null,
                'lastSeq'      => $hello['lastSeq'] ?? 0,
                'resumeFromSeq' => $hello['resumeFromSeq'] ?? 0,
                'subscriptions' => $hello['subscriptions'] ?? null,
            ];
            $instance['capabilities'] = $hello['capabilities'] ?? [];
            if (isset($hello['instance']['displayName'])) {
                $instance['label'] = $instance['label'] ?: $hello['instance']['displayName'];
            }
        }

        $maxSeq = (int)$instance['lastSeq'];
        foreach ($frames as $frame) {
            if (!is_array($frame)) {
                continue;
            }
            switch ($frame['type'] ?? '') {
                case 'hello':
                    $resumeFrom = 0;
                    foreach ($instance['events'] as $event) {
                        $resumeFrom = max($resumeFrom, (int)($event['seq'] ?? 0));
                    }
                    queueFrame($state, $instanceId, [
                        'v'               => PROTOCOL_VERSION,
                        'type'            => 'hello.ack',
                        'instanceId'      => $instanceId,
                        'serverTime'      => (int)(microtime(true) * 1000),
                        'heartbeatMs'     => 30000,
                        'resumeFromSeq'   => $resumeFrom,
                        'serverSeq'       => (int)$instance['cursor'],
                        'pollWaitMs'      => $GLOBALS['POLL_MAX_MS'],
                    ]);
                    // 默认订阅：全局主题；逐会话订阅由 UI 或后端按需发起
                    queueFrame($state, $instanceId, [
                        'v'      => PROTOCOL_VERSION,
                        'type'   => 'subscribe',
                        'id'     => 'sub-init',
                        'topics' => ['instance', 'sessions', 'jobs', 'approvals'],
                        'snapshot' => true,
                    ]);
                    break;

                case 'event':
                    $seq = (int)($frame['seq'] ?? 0);
                    $duplicate = false;
                    foreach ($instance['events'] as $existing) {
                        if ((int)($existing['seq'] ?? 0) === $seq) {
                            $duplicate = true;
                            break;
                        }
                    }
                    if (!$duplicate) {
                        $instance['events'][] = $frame;
                        if (count($instance['events']) > $GLOBALS['EVENT_LIMIT']) {
                            $instance['events'] = array_slice($instance['events'], -$GLOBALS['EVENT_LIMIT']);
                        }
                    }
                    $instance['lastSeq'] = max((int)$instance['lastSeq'], $seq);
                    $maxSeq = max($maxSeq, $seq);
                    break;

                case 'response':
                    $id = (string)($frame['id'] ?? '');
                    if ($id !== '') {
                        $instance['responses'][$id] = $frame;
                        unset($instance['pendingRequests'][$id]);
                    }
                    // 订阅响应顺带刷新订阅视图
                    if ($id === 'sub-init' || str_starts_with($id, 'sub-')) {
                        $result = $frame['result'] ?? null;
                        if (is_array($result)) {
                            $instance['subscriptions'] = [
                                'topics'           => $result['topics'] ?? [],
                                'sessions'         => $result['sessions'] ?? [],
                                'assistantStreams' => $result['assistantStreams'] ?? [],
                            ];
                        }
                    }
                    break;

                case 'ping':
                    queueFrame($state, $instanceId, [
                        'v'  => PROTOCOL_VERSION,
                        'type' => 'pong',
                        'ts' => (int)(microtime(true) * 1000),
                    ]);
                    break;

                case 'ack':
                    $instance['cursor'] = max((int)$instance['cursor'], (int)($frame['seq'] ?? 0));
                    break;

                case 'bye':
                    // HTTP 载体没有"连接关闭"事件，卸载信号只能来自这一帧。
                    // 标记断开而不是删除，避免与紧接其后的重连抢跑。
                    $instance['disconnectedAt'] = time();
                    $instance['lastSeenAt'] = time();
                    break;
            }
        }
        return $maxSeq;
    });

    jsonOut(200, ['accepted' => $accepted]);
}

// GET {base}/inbox —— 插件下行（长轮询）
if ($route === '/inbox' && $requestMethod === 'GET') {
    $key = extractKey(null, null);
    $entry = authorizeKey($key);
    if ($entry === null) {
        jsonOut(401, ['error' => ['code' => 'unauthorized', 'message' => '未登记的实例 key']]);
    }
    $instanceId = (string)($_GET['instanceId'] ?? ($entry['instanceId'] ?? ''));
    if ($instanceId === '') {
        jsonOut(400, ['error' => ['code' => 'bad_request', 'message' => '缺少 instanceId']]);
    }
    $waitMs = (int)($_GET['waitMs'] ?? $POLL_MAX_MS);
    $waitMs = max(0, min($waitMs, $POLL_MAX_MS));
    $deadline = microtime(true) + ($waitMs / 1000);

    do {
        $frames = withState(function (array &$state) use ($instanceId) {
            if (!isset($state['instances'][$instanceId])) {
                return null;
            }
            $instance = &$state['instances'][$instanceId];
            $instance['lastSeenAt'] = time();
            $frames = $instance['inbox'];
            $instance['inbox'] = [];
            return $frames;
        });
        if ($frames === null) {
            jsonOut(404, ['error' => ['code' => 'not_found', 'message' => '未知实例：请先完成 hello']]);
        }
        if (count($frames) > 0) {
            $cursor = withState(fn (array &$s) => (int)($s['instances'][$instanceId]['cursor'] ?? 0), false);
            jsonOut(200, ['frames' => $frames, 'cursor' => $cursor, 'waitMs' => $POLL_MAX_MS]);
        }
        if (microtime(true) >= $deadline) {
            break;
        }
        usleep(120000); // 120ms：兼顾响应速度与 CPU
    } while (true);

    $cursor = withState(fn (array &$s) => (int)($s['instances'][$instanceId]['cursor'] ?? 0), false);
    jsonOut(200, ['frames' => [], 'cursor' => $cursor, 'waitMs' => $POLL_MAX_MS]);
}

// GET {base}/ws —— 明确告知：PHP 无法升级 WebSocket
if ($route === '/ws') {
    jsonOut(426, [
        'error' => [
            'code'    => 'websocket_unsupported',
            'message' => '本 PHP 中转不支持 WebSocket。插件会（在 transport=auto 时）自动回退到 HTTP 长轮询；'
                       . '也可以把插件配置里的 transport 直接设为 http。',
        ],
    ]);
}

// ── 管理接口 ──────────────────────────────────────────────────────

// GET {base}/keys
if ($route === '/keys' && $requestMethod === 'GET') {
    requireAdmin();
    $rows = [];
    foreach (loadKeys() as $entry) {
        $rows[] = [
            'fingerprint' => fingerprint((string)$entry['key']),
            'label'       => $entry['label'] ?? null,
            'instanceId'  => $entry['instanceId'] ?? null,
            'addedAt'     => $entry['addedAt'] ?? null,
        ];
    }
    jsonOut(200, ['keys' => $rows, 'keysFile' => $KEYS_FILE]);
}

// POST {base}/keys  { key, label? }
if ($route === '/keys' && $requestMethod === 'POST') {
    requireAdmin();
    $body = readJsonBody();
    $key = trim((string)($body['key'] ?? ''));
    if (strlen($key) < 16) {
        jsonOut(400, ['error' => ['code' => 'invalid', 'message' => 'key 至少 16 个字符']]);
    }
    if (authorizeKey($key) !== null) {
        jsonOut(409, ['error' => ['code' => 'exists', 'message' => '这个 key 已经登记过了']]);
    }
    $keys = loadKeys();
    $entry = ['key' => $key, 'label' => $body['label'] ?? null, 'addedAt' => date('c')];
    $keys[] = $entry;
    saveKeys($keys);
    // 从待配对列表里移除
    withState(function (array &$state) use ($key) {
        $state['pendingPairings'] = array_values(array_filter(
            $state['pendingPairings'],
            fn ($p) => ($p['key'] ?? '') !== $key
        ));
    });
    jsonOut(200, ['added' => ['fingerprint' => fingerprint($key), 'label' => $entry['label']]]);
}

// POST {base}/keys/remove  { key | fingerprint }
if ($route === '/keys/remove' && $requestMethod === 'POST') {
    requireAdmin();
    $body = readJsonBody();
    $selector = (string)($body['key'] ?? ($body['fingerprint'] ?? ''));
    $keys = loadKeys();
    $remaining = [];
    $removed = false;
    foreach ($keys as $entry) {
        if ((string)$entry['key'] === $selector || fingerprint((string)$entry['key']) === $selector) {
            $removed = true;
            continue;
        }
        $remaining[] = $entry;
    }
    if ($removed) {
        saveKeys($remaining);
    }
    jsonOut($removed ? 200 : 404, ['removed' => $removed]);
}

// GET {base}/pending
if ($route === '/pending' && $requestMethod === 'GET') {
    requireAdmin();
    $data = withState(function (array &$state) {
        $rows = [];
        foreach ($state['pendingPairings'] as $pairing) {
            $rows[] = [
                'fingerprint' => $pairing['fingerprint'] ?? fingerprint((string)($pairing['key'] ?? '')),
                'instanceId'  => $pairing['instanceId'] ?? '',
                'reason'      => $pairing['reason'] ?? '',
                'at'          => $pairing['at'] ?? time(),
                'key'         => $pairing['key'] ?? '',
            ];
        }
        return ['pending' => $rows, 'autoAccept' => (bool)$state['autoAccept']];
    }, false);
    jsonOut(200, $data);
}

// POST {base}/pending/allow  { key }  —— 一键登记
if ($route === '/pending/allow' && $requestMethod === 'POST') {
    requireAdmin();
    $body = readJsonBody();
    $key = (string)($body['key'] ?? '');
    if ($key === '') {
        jsonOut(400, ['error' => ['code' => 'invalid', 'message' => '缺少 key']]);
    }
    if (authorizeKey($key) === null) {
        $keys = loadKeys();
        $keys[] = ['key' => $key, 'label' => $body['label'] ?? null, 'addedAt' => date('c')];
        saveKeys($keys);
    }
    withState(function (array &$state) use ($key) {
        $state['pendingPairings'] = array_values(array_filter(
            $state['pendingPairings'],
            fn ($p) => ($p['key'] ?? '') !== $key
        ));
    });
    jsonOut(200, ['allowed' => fingerprint($key)]);
}

// POST {base}/pending/auto  { enabled }
if ($route === '/pending/auto' && $requestMethod === 'POST') {
    requireAdmin();
    $body = readJsonBody();
    $enabled = (bool)($body['enabled'] ?? false);
    withState(function (array &$state) use ($enabled) {
        $state['autoAccept'] = $enabled;
    });
    jsonOut(200, ['autoAccept' => $enabled]);
}

// GET {base}/instances
if ($route === '/instances' && $requestMethod === 'GET') {
    requireAdmin();
    $rows = withState(function (array &$state) {
        $rows = [];
        foreach ($state['instances'] as $id => $instance) {
            $rows[] = [
                'instanceId'      => $id,
                'label'           => $instance['label'] ?? null,
                'keyFingerprint'  => $instance['keyFingerprint'] ?? null,
                'transport'       => $instance['transport'] ?? 'http',
                'tls'             => (bool)($instance['tls'] ?? false),
                'connectedAt'     => $instance['connectedAt'] ?? null,
                'lastSeenAt'      => $instance['lastSeenAt'] ?? null,
                'disconnectedAt'  => $instance['disconnectedAt'] ?? null,
                'lastSeq'         => $instance['lastSeq'] ?? 0,
                'eventCount'      => count($instance['events'] ?? []),
                'capabilities'    => $instance['capabilities'] ?? [],
                'subscriptions'   => $instance['subscriptions'] ?? [],
                'pendingRequests' => count($instance['pendingRequests'] ?? []),
                'lastEventKind'   => empty($instance['events']) ? null : ($instance['events'][count($instance['events']) - 1]['kind'] ?? null),
                'pluginVersion'   => $instance['hello']['instance']['pluginVersion'] ?? null,
                'hostname'        => $instance['hello']['instance']['hostname'] ?? null,
                'platform'        => $instance['hello']['instance']['platform'] ?? null,
            ];
        }
        return $rows;
    }, false);
    jsonOut(200, ['instances' => $rows]);
}

// GET {base}/instances/{id}/events?since=&limit=
if ($requestMethod === 'GET' && preg_match('#^/instances/([^/]+)/events$#', (string)$route, $m)) {
    requireAdmin();
    $instanceId = urldecode($m[1]);
    $since = (int)($_GET['since'] ?? 0);
    $limit = max(1, min((int)($_GET['limit'] ?? 200), 1000));
    $data = withState(function (array &$state) use ($instanceId, $since, $limit) {
        if (!isset($state['instances'][$instanceId])) {
            return null;
        }
        $events = [];
        foreach ($state['instances'][$instanceId]['events'] as $event) {
            if ((int)($event['seq'] ?? 0) > $since) {
                $events[] = $event;
            }
        }
        $events = array_slice($events, -$limit);
        return ['events' => $events, 'lastSeq' => (int)$state['instances'][$instanceId]['lastSeq']];
    }, false);
    if ($data === null) {
        jsonOut(404, ['error' => ['code' => 'not_found', 'message' => '未知实例']]);
    }
    jsonOut(200, $data);
}

// POST {base}/instances/{id}/request  { method, params }
if ($requestMethod === 'POST' && preg_match('#^/instances/([^/]+)/request$#', (string)$route, $m)) {
    requireAdmin();
    $instanceId = urldecode($m[1]);
    $body = readJsonBody();
    $method = (string)($body['method'] ?? '');
    if ($method === '') {
        jsonOut(400, ['error' => ['code' => 'invalid', 'message' => '缺少 method']]);
    }
    $id = 'req-' . bin2hex(random_bytes(6));
    $frame = [
        'v'      => PROTOCOL_VERSION,
        'type'   => 'request',
        'id'     => $id,
        'method' => $method,
        'params' => is_array($body['params'] ?? null) ? $body['params'] : new stdClass(),
    ];
    $ok = withState(function (array &$state) use ($instanceId, $id, $frame, $method) {
        if (!isset($state['instances'][$instanceId])) {
            return false;
        }
        queueFrame($state, $instanceId, $frame);
        $state['instances'][$instanceId]['pendingRequests'][$id] = ['method' => $method, 'at' => time()];
        return true;
    });
    if (!$ok) {
        jsonOut(404, ['error' => ['code' => 'not_found', 'message' => '未知实例（该机器还没连上或已离线）']]);
    }
    // 立即返回 id：UI 用 /response?id= 轮询结果。
    // （不能在这里阻塞等待：php -S 是单进程，阻塞会卡住插件拉取队列，形成死锁。）
    jsonOut(200, ['queued' => true, 'id' => $id, 'method' => $method]);
}

// GET {base}/instances/{id}/response?id=
if ($requestMethod === 'GET' && preg_match('#^/instances/([^/]+)/response$#', (string)$route, $m)) {
    requireAdmin();
    $instanceId = urldecode($m[1]);
    $id = (string)($_GET['id'] ?? '');
    if ($id === '') {
        jsonOut(400, ['error' => ['code' => 'invalid', 'message' => '缺少 id']]);
    }
    $frame = withState(function (array &$state) use ($instanceId, $id) {
        return $state['instances'][$instanceId]['responses'][$id] ?? null;
    }, false);
    if ($frame === null) {
        jsonOut(200, ['ready' => false]);
    }
    jsonOut(200, ['ready' => true, 'frame' => $frame]);
}

// POST {base}/instances/{id}/forget —— 忘记这台机器（清掉它的内存状态）
if ($requestMethod === 'POST' && preg_match('#^/instances/([^/]+)/forget$#', (string)$route, $m)) {
    requireAdmin();
    $instanceId = urldecode($m[1]);
    $removed = withState(function (array &$state) use ($instanceId) {
        if (!isset($state['instances'][$instanceId])) {
            return false;
        }
        unset($state['instances'][$instanceId]);
        return true;
    });
    jsonOut($removed ? 200 : 404, ['forgotten' => $removed]);
}

// POST {base}/admin/clear —— 清空全部中转状态（不动 key 白名单）
if ($route === '/admin/clear' && $requestMethod === 'POST') {
    requireAdmin();
    withState(function (array &$state) {
        $state['instances'] = [];
        $state['pendingPairings'] = [];
    });
    jsonOut(200, ['cleared' => true]);
}

jsonOut(404, ['error' => ['code' => 'not_found', 'message' => '未知路由：' . $requestMethod . ' ' . $requestPath]]);

// ─────────────────────────── 测试 UI ───────────────────────────

/**
 * 输出内置 HTML 调试台。
 *
 * 页面本身不依赖任何外部资源（离线可用），所有数据都来自上面的 API。
 */
function renderUi(string $basePath, int $pollMaxMs, bool $cliServer, bool $adminRequired): void
{
    $html = <<<'HTML'
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh2server 测试台</title>
<style>
  :root { color-scheme: dark; --bg:#0f1216; --panel:#171c22; --line:#2a323c; --fg:#e6edf3; --muted:#8b98a5;
          --acc:#4c9aff; --ok:#3fb950; --warn:#d29922; --err:#f85149; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:13px/1.55 "Segoe UI",system-ui,-apple-system,sans-serif; }
  header { position:sticky; top:0; z-index:5; background:#11161b; border-bottom:1px solid var(--line); padding:10px 16px; display:flex; gap:14px; align-items:center; flex-wrap:wrap; }
  header h1 { font-size:15px; margin:0 12px 0 0; font-weight:600; }
  .wrap { padding:14px 16px 60px; display:grid; gap:14px; grid-template-columns:minmax(320px,1fr) minmax(420px,1.35fr); align-items:start; }
  @media (max-width:1080px) { .wrap { grid-template-columns:1fr; } }
  section { background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  section > h2 { margin:0; padding:9px 12px; font-size:13px; background:#1c232b; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:8px; }
  section > h2 .spacer { flex:1; }
  .body { padding:10px 12px; display:grid; gap:9px; }
  .col { display:grid; gap:14px; }
  button { background:#222a33; color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:5px 10px; cursor:pointer; font:inherit; }
  button:hover:not(:disabled) { border-color:var(--acc); }
  button:disabled { opacity:.45; cursor:not-allowed; }
  button.primary { background:#1d4ed8; border-color:#1d4ed8; }
  button.danger { border-color:#5c2b2b; color:#ffb3ae; }
  button.ok { border-color:#2a5a33; color:#a8e6b0; }
  button.sm { padding:2px 7px; font-size:12px; }
  input, textarea, select { background:#0e1319; color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:5px 8px; font:inherit; width:100%; }
  textarea { min-height:64px; resize:vertical; font-family:ui-monospace,Consolas,monospace; }
  label { color:var(--muted); font-size:12px; display:block; margin-bottom:3px; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th, td { text-align:left; padding:4px 6px; border-bottom:1px solid #222a33; vertical-align:top; }
  th { color:var(--muted); font-weight:500; }
  tr.sel td { background:#13233a; }
  tr.click { cursor:pointer; }
  tr.click:hover td { background:#1a2330; }
  code, pre { font-family:ui-monospace,Consolas,monospace; }
  pre { background:#0e1319; border:1px solid var(--line); border-radius:6px; padding:8px; overflow:auto; max-height:280px; margin:0; white-space:pre-wrap; word-break:break-word; }
  .pill { font-size:11px; padding:1px 7px; border-radius:99px; border:1px solid var(--line); color:var(--muted); }
  .pill.on { color:#a8e6b0; border-color:#2a5a33; }
  .pill.off { color:#ffb3ae; border-color:#5c2b2b; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  .grid3 { display:grid; grid-template-columns:1fr 1fr auto; gap:8px; align-items:end; }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .muted { color:var(--muted); }
  .mono { font-family:ui-monospace,Consolas,monospace; }
  .empty { color:var(--muted); padding:6px 0; }
  #toast { position:fixed; right:14px; bottom:14px; display:grid; gap:8px; z-index:20; }
  #toast div { background:#1c232b; border:1px solid var(--line); border-left:3px solid var(--acc); padding:7px 12px; border-radius:6px; max-width:420px; }
  #toast div.err { border-left-color:var(--err); }
  #toast div.ok { border-left-color:var(--ok); }
  .kv { display:grid; grid-template-columns:auto 1fr; gap:2px 10px; font-size:12px; }
  .kv span:nth-child(odd) { color:var(--muted); }
  details summary { cursor:pointer; color:var(--muted); }
  .tabs { display:flex; gap:6px; flex-wrap:wrap; }
  .tabs button.active { border-color:var(--acc); color:#cfe4ff; }
  .tabpane[hidden] { display:none; }
</style>
</head>
<body>
<header>
  <h1>dsh2server 测试台</h1>
  <span class="pill" id="pBase"></span>
  <span class="pill" id="pPoll"></span>
  <span class="pill" id="pCli"></span>
  <span class="pill" id="pStatus">连接中…</span>
  <span class="spacer" style="flex:1"></span>
  <span class="muted" id="pAdminHint"></span>
  <button id="btnRefresh">刷新全部</button>
  <button id="btnSelfTest">一键自检</button>
</header>

<div class="wrap">
  <!-- 左列 -->
  <div class="col">
    <section>
      <h2>① 配对 / Key 白名单 <span class="spacer"></span><span class="pill" id="pKeys">0</span></h2>
      <div class="body">
        <div id="pendingBox"></div>
        <div class="grid3">
          <div><label>key（插件日志里打印的 dshk_…）</label><input id="newKey" placeholder="dshk_..."></div>
          <div><label>备注</label><input id="newLabel" placeholder="我的笔记本"></div>
          <div><button class="primary" id="btnAddKey">登记</button></div>
        </div>
        <table><thead><tr><th>指纹</th><th>备注</th><th>登记时间</th><th></th></tr></thead><tbody id="keysBody"></tbody></table>
        <div id="keysEmpty" class="empty">还没有登记任何机器。</div>
      </div>
    </section>

    <section>
      <h2>② 在线机器 <span class="spacer"></span><button class="sm" id="btnForget" disabled>忘记选中</button></h2>
      <div class="body">
        <table><thead><tr><th>instanceId</th><th>备注</th><th>传输</th><th>最后活动</th><th>事件</th></tr></thead><tbody id="instBody"></tbody></table>
        <div id="instEmpty" class="empty">还没有机器连上来。启动 dsh 后稍等片刻（最多 60 秒重连一次）。</div>
      </div>
    </section>

    <section>
      <h2>③ 事件流 <span class="spacer"></span><label style="display:inline;margin:0"><input type="checkbox" id="chkAutoRefresh" checked style="width:auto"> 自动刷新</label></h2>
      <div class="body">
        <div class="row">
          <button class="sm" id="btnEvents">立即刷新</button>
          <button class="sm" id="btnClearView">清空视图</button>
          <span class="muted" id="evCount"></span>
        </div>
        <div class="row">
          <label style="margin:0"><input type="checkbox" id="filtAll" style="width:auto"> 显示全部（默认只看会话/错误/审批）</label>
        </div>
        <pre id="events" style="max-height:420px"></pre>
      </div>
    </section>
  </div>

  <!-- 右列 -->
  <div class="col">
    <section>
      <h2>④ 操作面板 <span class="spacer"></span><span class="pill" id="pSel">未选择机器</span></h2>
      <div class="body">
        <div class="tabs" id="tabs">
          <button data-tab="basic" class="active">状态</button>
          <button data-tab="sessions">会话</button>
          <button data-tab="control">控制</button>
          <button data-tab="extra">进阶</button>
          <button data-tab="raw">原始调用</button>
        </div>

        <div class="tabpane" data-pane="basic">
          <div class="row"><button id="btnInfo">instance.info</button><button id="btnHealth">instance.health</button></div>
          <pre id="outInfo">—</pre>
        </div>

        <div class="tabpane" data-pane="sessions" hidden>
          <div class="row">
            <button id="btnSessions">session.list</button>
            <button id="btnWorkspaces">workspace.list</button>
            <button id="btnSubscribe">订阅所选会话事件流</button>
          </div>
          <table><thead><tr><th>sessionId</th><th>工作目录</th><th>状态</th><th>更新于</th></tr></thead><tbody id="sessBody"></tbody></table>
          <div id="sessEmpty" class="empty">点「session.list」拉取会话。</div>
          <details><summary>工作目录结果</summary><pre id="outWs">—</pre></details>
        </div>

        <div class="tabpane" data-pane="control" hidden>
          <div><label>下发给所选会话的内容</label><textarea id="promptText" placeholder="例如：跑一下 npm test"></textarea></div>
          <div class="row">
            <select id="promptMode" style="width:auto"><option value="queue">新命令（新一轮）</option><option value="steer">追加指示（当前这一轮）</option></select>
            <label style="margin:0"><input type="checkbox" id="promptForce" style="width:auto"> 忽略暂停强制投递</label>
            <button class="primary" id="btnPrompt">发送</button>
          </div>
          <div class="row">
            <button id="btnInterrupt">中断（保留队列）</button>
            <button class="danger" id="btnCancel">取消（丢弃队列）</button>
            <button id="btnPause">暂停运行</button>
            <button class="ok" id="btnResume">恢复运行</button>
          </div>
          <div class="row">
            <label style="margin:0">审批策略</label>
            <button class="sm" id="btnPolicyRead">读取</button>
            <button class="sm" data-policy="ask">设为 ask</button>
            <button class="sm" data-policy="never">设为 never</button>
          </div>
          <pre id="outControl">—</pre>
        </div>

        <div class="tabpane" data-pane="extra" hidden>
          <div class="grid2">
            <div>
              <label>新建会话（工作目录）</label>
              <div class="grid3"><input id="newCwd" placeholder="D:\\Project\\demo"><button class="primary" id="btnCreate">创建</button></div>
            </div>
            <div>
              <label>改名 / 搜索</label>
              <div class="grid3"><input id="renameTitle" placeholder="新标题"><button id="btnRename">改名</button><button id="btnSearch">搜索上文</button></div>
            </div>
          </div>
          <div class="row">
            <button id="btnJobs">job.list</button>
            <button id="btnGoals">goal.get</button>
            <button class="sm" id="btnGoalPause">goal.pause</button>
            <button class="sm" id="btnGoalResume">goal.resume</button>
            <button class="sm" id="btnGoalComplete">goal.complete</button>
            <button id="btnCommands">command.list</button>
          </div>
          <table><thead><tr><th>类型</th><th>标识</th><th>内容</th><th>操作</th></tr></thead><tbody id="extraBody"></tbody></table>
          <pre id="outExtra">—</pre>
        </div>

        <div class="tabpane" data-pane="raw" hidden>
          <div class="grid2">
            <div><label>method</label><input id="rawMethod" value="session.get"></div>
            <div><label>params（JSON）</label><input id="rawParams" value='{"sessionId":""}'></div>
          </div>
          <div class="row"><button class="primary" id="btnRaw">发送</button><span class="muted">未选择会话时请自行填写完整 params</span></div>
          <pre id="outRaw">—</pre>
        </div>

        <div><label>最近一次响应</label><pre id="outLast">—</pre></div>
      </div>
    </section>

    <section>
      <h2>⑤ 审批 / 提问 <span class="spacer"></span><span class="pill" id="pApprovals">0</span></h2>
      <div class="body">
        <div class="muted">需要插件配置 <code>forwardApprovals: true</code>（可选 <code>forwardQuestions: true</code>）才会把本机的审批/提问转发到这里。</div>
        <div id="approvalBox" class="empty">暂无待决请求。</div>
      </div>
    </section>

    <section>
      <h2>⑥ 自检结果</h2>
      <div class="body"><pre id="outSelfTest">点右上角「一键自检」依次验证：握手 → 能力 → 会话列表 → 工作目录 → 命令下发 → 中断。</pre></div>
    </section>
  </div>
</div>

<div id="toast"></div>

<script>
const BASE = __BASE__;
const POLL_MAX_MS = __POLL__;
const CLI_SERVER = __CLI__;
const ADMIN_REQUIRED = __ADMIN__;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtTime = (t) => (t ? new Date(t < 1e12 ? t * 1000 : t).toLocaleTimeString() : "—");

const state = {
  instanceId: null,
  sessionId: null,
  since: 0,
  adminKey: localStorage.getItem("dshRelayAdminKey") || "",
  pendingApprovals: new Map(),
  events: [],
  viewFrom: 0,
};

function toast(msg, kind = "") {
  const el = document.createElement("div");
  if (kind) el.className = kind;
  el.textContent = msg;
  $("toast").appendChild(el);
  setTimeout(() => el.remove(), kind === "err" ? 8000 : 4200);
}

async function api(path, options = {}) {
  const headers = { accept: "application/json" };
  if (state.adminKey) headers["x-admin-key"] = state.adminKey;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(BASE + path, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || ("HTTP " + res.status);
    const err = new Error(msg);
    err.payload = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

/** 下发一个方法并等待插件的响应（轮询，避免阻塞 PHP 单进程）。 */
async function run(method, params = {}, timeoutMs = 30000) {
  if (!state.instanceId) throw new Error("请先在上方选择一台在线机器");
  const queued = await api("/instances/" + encodeURIComponent(state.instanceId) + "/request", {
    method: "POST",
    body: { method, params },
  });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await api("/instances/" + encodeURIComponent(state.instanceId) + "/response?id=" + encodeURIComponent(queued.id));
    if (r.ready) return r.frame;
    if (Date.now() > deadline) throw new Error("等待 " + method + " 响应超时");
    await sleep(140);
  }
}

function show(id, value) {
  $(id).textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function setLast(frame) { show("outLast", frame); }

/* ── 刷新 ─────────────────────────────────────────────────────── */

async function refreshKeys() {
  try {
    const data = await api("/keys");
    $("pKeys").textContent = data.keys.length + " 把 key";
    $("keysBody").innerHTML = data.keys.map((k) =>
      `<tr><td class="mono">${esc(k.fingerprint)}</td><td>${esc(k.label || "")}</td><td class="muted">${esc(k.addedAt || "")}</td>` +
      `<td><button class="sm danger" data-keyfp="${esc(k.fingerprint)}">删除</button></td></tr>`).join("");
    $("keysEmpty").hidden = data.keys.length > 0;
    $("keysBody").querySelectorAll("button[data-keyfp]").forEach((b) => {
      b.onclick = async () => {
        if (!confirm("删除这个 key？该机器下一次重连会被拒绝。")) return;
        await api("/keys/remove", { method: "POST", body: { fingerprint: b.dataset.keyfp } });
        toast("已删除 " + b.dataset.keyfp, "ok");
        refreshKeys(); refreshPending();
      };
    });
  } catch (e) { keysFailed(e); }
}

function keysFailed(e) {
  if (e.status === 401 && !state.adminKey) {
    const key = prompt("管理接口需要 x-admin-key，请输入：");
    if (key) { state.adminKey = key; localStorage.setItem("dshRelayAdminKey", key); refreshAll(); return; }
  }
  toast("读取 key 失败：" + e.message, "err");
}

async function refreshPending() {
  try {
    const data = await api("/pending");
    const rows = data.pending || [];
    if (rows.length === 0) {
      $("pendingBox").innerHTML = `<div class="empty">没有等待配对的机器。` +
        `<label style="display:inline;margin-left:8px"><input type="checkbox" id="chkAutoAccept" style="width:auto" ${data.autoAccept ? "checked" : ""}> 自动接受新机器（仅测试用）</label></div>`;
    } else {
      $("pendingBox").innerHTML =
        `<div style="border-left:3px solid var(--warn);padding-left:8px">` +
        `<div class="muted">有 ${rows.length} 台机器尝试连接但未被授权，点「允许」即可登记：</div>` +
        rows.map((p) =>
          `<div class="row" style="margin-top:4px"><span class="mono">${esc(p.fingerprint)}</span>` +
          `<span class="muted">${esc(p.instanceId || "")}</span>` +
          `<button class="sm ok" data-allow="${esc(p.key)}" data-label="${esc(p.instanceId || "")}">允许</button></div>`).join("") +
        `<div class="row" style="margin-top:6px"><label style="margin:0"><input type="checkbox" id="chkAutoAccept" style="width:auto" ${data.autoAccept ? "checked" : ""}> 自动接受新机器（仅测试用）</label></div></div>`;
      $("pendingBox").querySelectorAll("button[data-allow]").forEach((b) => {
        b.onclick = async () => {
          await api("/pending/allow", { method: "POST", body: { key: b.dataset.allow, label: b.dataset.label || null } });
          toast("已登记，机器会自动重连并上线", "ok");
          refreshKeys(); refreshPending(); refreshInstances();
        };
      });
    }
    const chk = $("chkAutoAccept");
    if (chk) chk.onchange = async () => {
      await api("/pending/auto", { method: "POST", body: { enabled: chk.checked } });
      toast(chk.checked ? "已开启自动接受（测试用，不建议长期开着）" : "已关闭自动接受");
      refreshPending();
    };
  } catch (e) { keysFailed(e); }
}

async function refreshInstances() {
  try {
    const data = await api("/instances");
    const rows = data.instances || [];
    const isOnline = (r) => !r.disconnectedAt && Date.now() / 1000 - (r.lastSeenAt || 0) < 120;
    const online = rows.filter(isOnline);
    $("pStatus").textContent = online.length ? online.length + " 台在线" : "暂无在线机器";
    $("pStatus").className = "pill " + (online.length ? "on" : "off");
    $("instBody").innerHTML = rows.map((r) => {
      const fresh = isOnline(r);
      const caps = Object.keys(r.capabilities || {}).length;
      return `<tr class="click ${r.instanceId === state.instanceId ? "sel" : ""}" data-id="${esc(r.instanceId)}">` +
        `<td class="mono">${esc(r.instanceId)}${fresh ? "" : ' <span class="pill off">离线</span>'}</td>` +
        `<td>${esc(r.label || r.hostname || "")}</td>` +
        `<td>${esc(r.transport)}${r.tls ? " / TLS" : ""}<span class="muted"> · ${caps} 项能力</span></td>` +
        `<td class="muted">${fmtTime(r.lastSeenAt)}</td>` +
        `<td>${r.eventCount}</td></tr>`;
    }).join("");
    $("instEmpty").hidden = rows.length > 0;
    $("instBody").querySelectorAll("tr[data-id]").forEach((tr) => {
      tr.onclick = () => { selectInstance(tr.dataset.id); };
    });
  } catch (e) { keysFailed(e); }
}

async function refreshEvents() {
  if (!state.instanceId) return;
  try {
    const data = await api("/instances/" + encodeURIComponent(state.instanceId) + "/events?since=" + state.since + "&limit=300");
    for (const frame of data.events || []) {
      state.since = Math.max(state.since, frame.seq || 0);
      handleEvent(frame);
    }
    renderEvents();
  } catch (e) { /* 实例可能刚被忘记 */ }
}

const INTERESTING = /^(session|approval|question|goal|todos|bridge)\//;
function handleEvent(frame) {
  state.events.push(frame);
  if (state.events.length > 800) state.events = state.events.slice(-800);
  const kind = frame.kind || "";
  if (kind === "approval/request") addApproval(frame, "approval");
  if (kind === "question/request") addApproval(frame, "question");
  if (kind === "session/approval-policy" || kind === "session/paused" || kind === "session/resumed") { /* 仅展示 */ }
}

function renderEvents() {
  const showAll = $("filtAll").checked;
  const rows = state.events.filter((f) => showAll || INTERESTING.test(f.kind || "") || f.truncated);
  $("evCount").textContent = state.events.length + " 条事件，显示 " + rows.length + " 条";
  const el = $("events");
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  el.textContent = rows.slice(-300).map((f) => {
    const kind = (f.kind || "").padEnd(26, " ");
    const data = f.truncated ? "[负载过大已截断] " + JSON.stringify(f.truncated) : JSON.stringify(f.data);
    return `#${String(f.seq).padStart(5, " ")} ${fmtTime(f.ts)} ${kind} ${f.sessionId ? f.sessionId + " " : ""}${data}`;
  }).join("\n");
  if (atBottom) el.scrollTop = el.scrollHeight;
}

/* ── 审批 ─────────────────────────────────────────────────────── */

function addApproval(frame, kind) {
  const d = frame.data || {};
  state.pendingApprovals.set(d.requestId, { kind, data: d });
  renderApprovals();
}

function renderApprovals() {
  $("pApprovals").textContent = state.pendingApprovals.size + " 个待决";
  const box = $("approvalBox");
  if (state.pendingApprovals.size === 0) {
    box.className = "empty";
    box.textContent = "暂无待决请求。";
    return;
  }
  box.className = "";
  box.innerHTML = [...state.pendingApprovals.entries()].map(([id, item]) => {
    const d = item.data;
    const desc = item.kind === "approval"
      ? `工具 <b>${esc(d.toolName)}</b> ${d.reason ? "— " + esc(d.reason) : ""}`
      : `${(d.questions || []).length} 个问题`;
    const buttons = item.kind === "approval"
      ? `<button class="sm ok" data-approve="${esc(id)}">允许一次</button><button class="sm danger" data-reject="${esc(id)}">拒绝</button>`
      : `<button class="sm" data-answer="${esc(id)}">填写回答…</button>`;
    return `<div class="row" style="border-left:3px solid var(--warn);padding-left:8px"><div style="flex:1">` +
      `<div>${esc(d.sessionId || "")} · ${desc}</div><div class="muted mono" style="font-size:11px">${esc(id)}</div></div>${buttons}</div>`;
  }).join("");
  box.querySelectorAll("button[data-approve]").forEach((b) => {
    b.onclick = () => respond(b.dataset.approve, "allowed-once");
  });
  box.querySelectorAll("button[data-reject]").forEach((b) => {
    b.onclick = () => respond(b.dataset.reject, "rejected");
  });
  box.querySelectorAll("button[data-answer]").forEach((b) => {
    b.onclick = () => answerQuestion(b.dataset.answer);
  });
}

async function respond(id, outcome) {
  try {
    const frame = await run("approval.respond", { requestId: id, outcome });
    toast("已应答：" + outcome + (frame.result && frame.result.matched === false ? "（插件侧已超时）" : ""), "ok");
    state.pendingApprovals.delete(id);
    renderApprovals();
  } catch (e) { toast("应答失败：" + e.message, "err"); }
}

async function answerQuestion(id) {
  const item = state.pendingApprovals.get(id);
  const questions = (item && item.data.questions) || [];
  const answers = [];
  for (const q of questions) {
    const options = (q.options || []).map((o) => o.label);
    const hint = options.length ? "可选：" + options.join(" / ") : "自由填写";
    const value = prompt(q.question + "\n" + hint, options[0] || "");
    if (value === null) return;
    answers.push({ id: q.id, selected: options.includes(value) ? [value] : [], custom: options.includes(value) ? undefined : value });
  }
  try {
    await run("question.answer", { requestId: id, answers });
    toast("已回答", "ok");
    state.pendingApprovals.delete(id);
    renderApprovals();
  } catch (e) { toast("回答失败：" + e.message, "err"); }
}

/* ── 交互 ─────────────────────────────────────────────────────── */

function selectInstance(id) {
  state.instanceId = id;
  state.sessionId = null;
  state.since = 0;
  state.events = [];
  $("pSel").textContent = id;
  $("btnForget").disabled = false;
  refreshInstances();
  renderEvents();
  run("instance.info").then((f) => { show("outInfo", f.result); setLast(f); })
    .catch((e) => toast("instance.info 失败：" + e.message, "err"));
}

function selectedSession() {
  if (!state.sessionId) { toast("请先在「会话」标签里点一行选中会话", "err"); return null; }
  return state.sessionId;
}

async function act(method, params, outId = "outControl") {
  try {
    const frame = await run(method, params);
    if (outId) show(outId, frame);
    setLast(frame);
    return frame;
  } catch (e) {
    if (outId) show(outId, { error: e.message });
    toast(method + " 失败：" + e.message, "err");
    return null;
  }
}

$("btnRefresh").onclick = () => refreshAll();
$("btnSelfTest").onclick = selfTest;
$("btnEvents").onclick = () => refreshEvents();
$("btnClearView").onclick = () => { state.events = []; state.since = 0; renderEvents(); };
$("filtAll").onchange = renderEvents;
$("btnAddKey").onclick = async () => {
  const key = $("newKey").value.trim();
  if (!key) return toast("请粘贴插件打印的 key", "err");
  try {
    await api("/keys", { method: "POST", body: { key, label: $("newLabel").value.trim() || null } });
    $("newKey").value = ""; $("newLabel").value = "";
    toast("已登记，机器会自动重连上线", "ok");
    refreshKeys(); refreshPending();
  } catch (e) { toast("登记失败：" + e.message, "err"); }
};
$("btnForget").onclick = async () => {
  if (!state.instanceId || !confirm("从服务器内存里忘掉 " + state.instanceId + "？")) return;
  await api("/instances/" + encodeURIComponent(state.instanceId) + "/forget", { method: "POST" });
  state.instanceId = null; state.sessionId = null;
  $("pSel").textContent = "未选择机器";
  $("btnForget").disabled = true;
  refreshInstances();
};

document.querySelectorAll("#tabs button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".tabpane").forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.tab; });
  };
});

$("btnInfo").onclick = async () => { const f = await act("instance.info", {}, "outInfo"); if (f) show("outInfo", f.result); };
$("btnHealth").onclick = () => act("instance.health", {}, "outInfo");

$("btnSessions").onclick = async () => {
  const frame = await act("session.list", {}, null);
  if (!frame) return;
  const items = (frame.result && frame.result.items) || [];
  $("sessBody").innerHTML = items.map((s) =>
    `<tr class="click ${s.sessionId === state.sessionId ? "sel" : ""}" data-sid="${esc(s.sessionId)}">` +
    `<td class="mono">${esc(s.sessionId)}</td><td class="mono">${esc(s.cwd || "")}</td>` +
    `<td>${s.running ? '<span class="pill on">运行中</span>' : '<span class="pill">空闲</span>'}</td>` +
    `<td class="muted">${fmtTime(s.updatedAt)}</td></tr>`).join("");
  $("sessEmpty").hidden = items.length > 0;
  $("sessBody").querySelectorAll("tr[data-sid]").forEach((tr) => {
    tr.onclick = () => {
      state.sessionId = tr.dataset.sid;
      $("rawParams").value = JSON.stringify({ sessionId: state.sessionId }, null, 0);
      renderSessions();
      toast("已选中会话 " + state.sessionId);
    };
  });
  if (!state.sessionId && items.length > 0) {
    state.sessionId = items[0].sessionId;
    $("rawParams").value = JSON.stringify({ sessionId: state.sessionId });
  }
  show("outLast", frame);
  await act("session.get", { sessionId: state.sessionId }, "outControl");
};
$("btnWorkspaces").onclick = async () => { const f = await act("workspace.list", {}, null); if (f) show("outWs", f.result); };
$("btnSubscribe").onclick = async () => {
  if (!state.instanceId) return toast("请先选择机器", "err");
  const body = { topics: ["instance", "sessions", "jobs", "approvals"], assistantStream: true };
  if (state.sessionId) body.sessions = [state.sessionId];
  await api("/instances/" + encodeURIComponent(state.instanceId) + "/subscribe", { method: "POST", body });
  toast("已请求订阅" + (state.sessionId ? "（含所选会话的逐条事件与流式输出）" : ""), "ok");
};

function renderSessions() {
  $("sessBody").querySelectorAll("tr[data-sid]").forEach((tr) => {
    tr.classList.toggle("sel", tr.dataset.sid === state.sessionId);
  });
}

$("btnPrompt").onclick = async () => {
  const sid = selectedSession(); if (!sid) return;
  const text = $("promptText").value.trim();
  if (!text) return toast("请输入内容", "err");
  const params = { sessionId: sid, text, mode: $("promptMode").value };
  if ($("promptForce").checked) params.force = true;
  const frame = await act("session.prompt", params);
  if (frame && frame.ok && frame.result && frame.result.deferred) toast("会话处于暂停，命令已排队（第 " + frame.result.position + " 位）", "ok");
};
$("btnInterrupt").onclick = () => { const s = selectedSession(); if (s) act("session.interrupt", { sessionId: s }); };
$("btnCancel").onclick = () => { const s = selectedSession(); if (s) act("session.cancel", { sessionId: s }); };
$("btnPause").onclick = () => { const s = selectedSession(); if (s) act("session.pause", { sessionId: s }); };
$("btnResume").onclick = () => { const s = selectedSession(); if (s) act("session.resume", { sessionId: s }); };
$("btnPolicyRead").onclick = () => { const s = selectedSession(); if (s) act("session.approvalPolicy", { sessionId: s }); };
document.querySelectorAll("button[data-policy]").forEach((b) => {
  b.onclick = () => { const s = selectedSession(); if (s) act("session.approvalPolicy", { sessionId: s, policy: b.dataset.policy }); };
});

$("btnCreate").onclick = async () => {
  const cwd = $("newCwd").value.trim();
  const frame = await act("session.create", cwd ? { cwd } : {});
  if (frame && frame.ok) { toast("已创建 " + frame.result.sessionId, "ok"); $("btnSessions").click(); }
};
$("btnRename").onclick = () => {
  const s = selectedSession(); if (!s) return;
  const title = $("renameTitle").value.trim(); if (!title) return toast("请输入新标题", "err");
  act("session.rename", { sessionId: s, title });
};
$("btnSearch").onclick = () => {
  const q = prompt("搜索会话内容："); if (!q) return;
  act("session.search", { query: q }, "outExtra");
};
$("btnJobs").onclick = async () => {
  const frame = await act("job.list", state.sessionId ? { sessionId: state.sessionId } : {}, null);
  if (!frame) return;
  renderExtra((frame.result.items || []).map((j) => ({
    type: "job", id: j.id, text: `${j.kind} · ${j.label} · ${j.status}${j.detail ? " · " + j.detail : ""}`,
    action: j.status === "running" ? `<button class="sm danger" data-kill="${esc(j.id)}">终止</button>` : "",
  })));
  show("outExtra", frame.result);
};
$("btnGoals").onclick = async () => {
  const s = selectedSession(); if (!s) return;
  const frame = await act("goal.get", { sessionId: s }, null);
  if (!frame) return;
  const g = frame.result.goal;
  renderExtra(g ? [{ type: "goal", id: g.id, text: `${g.phase} · ${g.objective} · 轮次 ${g.roundsStarted}/${g.maxGoalRounds}`, action: "" }] : []);
  show("outExtra", frame.result);
};
$("btnGoalPause").onclick = () => { const s = selectedSession(); if (s) act("goal.pause", { sessionId: s }, "outExtra"); };
$("btnGoalResume").onclick = () => { const s = selectedSession(); if (s) act("goal.resume", { sessionId: s }, "outExtra"); };
$("btnGoalComplete").onclick = () => { const s = selectedSession(); if (s) act("goal.complete", { sessionId: s }, "outExtra"); };
$("btnCommands").onclick = async () => {
  const s = selectedSession(); if (!s) return;
  const frame = await act("command.list", { sessionId: s }, null);
  if (!frame) return;
  renderExtra((frame.result.items || []).map((c) => ({
    type: "command", id: c.name, text: c.description || "", action: `<button class="sm" data-cmd="/${esc(c.name)}">执行</button>`,
  })));
  show("outExtra", frame.result);
};

function renderExtra(rows) {
  $("extraBody").innerHTML = rows.map((r) =>
    `<tr><td>${esc(r.type)}</td><td class="mono">${esc(r.id)}</td><td>${esc(r.text)}</td><td>${r.action}</td></tr>`).join("");
  $("extraBody").querySelectorAll("button[data-kill]").forEach((b) => {
    b.onclick = () => act("job.kill", state.sessionId ? { jobId: b.dataset.kill, sessionId: state.sessionId } : { jobId: b.dataset.kill }, "outExtra");
  });
  $("extraBody").querySelectorAll("button[data-cmd]").forEach((b) => {
    b.onclick = () => { const s = selectedSession(); if (s) act("command.run", { sessionId: s, line: b.dataset.cmd }, "outExtra"); };
  });
}

$("btnRaw").onclick = async () => {
  let params = {};
  try { params = JSON.parse($("rawParams").value || "{}"); } catch { return toast("params 不是合法 JSON", "err"); }
  await act($("rawMethod").value.trim(), params, "outRaw");
};

/* ── 自检 ─────────────────────────────────────────────────────── */

async function selfTest() {
  const out = [];
  const line = (name, ok, detail) => { out.push(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`); show("outSelfTest", out.join("\n")); };
  out.push("开始自检 " + new Date().toLocaleString());
  if (!state.instanceId) {
    const inst = await api("/instances").catch(() => ({ instances: [] }));
    if (inst.instances.length === 0) { line("找到在线机器", false, "没有机器连接；确认已登记 key 且 dsh 已启动"); return; }
    selectInstance(inst.instances[0].instanceId);
    await sleep(300);
  }
  line("选中机器", true, state.instanceId);

  const ping = await run("instance.ping").catch((e) => ({ ok: false, error: { message: e.message } }));
  line("握手 / instance.ping", !!ping.ok, ping.ok ? "往返正常" : (ping.error && ping.error.message));

  const info = await run("instance.info").catch((e) => ({ ok: false, error: { message: e.message } }));
  if (info.ok) {
    const caps = info.result.capabilities || {};
    const on = Object.keys(caps).filter((k) => caps[k]);
    line("能力协商", true, on.length + " 项：" + on.slice(0, 8).join(", ") + (on.length > 8 ? " …" : ""));
    line("链路信息", true, "transport=" + info.result.connection.transport + " insecure=" + info.result.connection.insecure);
    show("outInfo", info.result);
  } else {
    line("能力协商", false, info.error && info.error.message);
  }

  const sessions = await run("session.list").catch((e) => ({ ok: false, error: { message: e.message } }));
  const items = (sessions.ok && sessions.result.items) || [];
  line("会话列表", !!sessions.ok, sessions.ok ? items.length + " 个会话" : (sessions.error && sessions.error.message));
  if (items.length > 0 && !state.sessionId) {
    state.sessionId = items[0].sessionId;
    renderSessions();
  }

  const ws = await run("workspace.list").catch((e) => ({ ok: false, error: { message: e.message } }));
  line("工作目录", !!ws.ok, ws.ok ? (ws.result.items || []).length + " 个目录（来源 " + ws.result.source + "）" : (ws.error && ws.error.message));

  if (state.sessionId) {
    const get = await run("session.get", { sessionId: state.sessionId }).catch((e) => ({ ok: false, error: { message: e.message } }));
    line("会话详情", !!get.ok, get.ok ? "状态 " + get.result.status + "，工作目录 " + (get.result.header && get.result.header.cwd) : (get.error && get.error.message));

    const paused = get.ok && get.result.paused;
    if (paused) {
      const res = await run("session.resume", { sessionId: state.sessionId }).catch((e) => ({ ok: false, error: { message: e.message } }));
      line("恢复暂停中的会话", !!res.ok, res.ok ? "放行 " + res.result.delivered + " 条排队命令" : (res.error && res.error.message));
    }

    const marker = "[自检] " + new Date().toLocaleTimeString();
    if (!confirm("自检会向会话 " + state.sessionId + " 发送一条真实消息：\n\n  " + marker +
                 "\n\n随后立即中断它。这条消息会留在会话记录里。要继续吗？")) {
      line("下发命令", true, "已跳过（你取消了发送）");
      out.push("自检结束 " + new Date().toLocaleTimeString());
      show("outSelfTest", out.join("\n"));
      return;
    }
    const prompt = await run("session.prompt", { sessionId: state.sessionId, text: marker }).catch((e) => ({ ok: false, error: { message: e.message } }));
    if (prompt.ok) {
      line("下发命令", true, "已被接受" + (prompt.result.deferred ? "（会话暂停中，已排队）" : ""));
      const intr = await run("session.interrupt", { sessionId: state.sessionId }).catch((e) => ({ ok: false, error: { message: e.message } }));
      line("中断命令", !!intr.ok, intr.ok ? "已请求中止当前轮" : (intr.error && intr.error.message));
      line("提示", true, "自检发的是一条普通消息，会在会话里留下痕迹（内容：" + marker + "）");
    } else {
      line("下发命令", false, prompt.error && prompt.error.message);
    }
  } else {
    line("会话相关自检", false, "没有可用会话，先手动创建一个");
  }
  out.push("自检结束 " + new Date().toLocaleTimeString());
  show("outSelfTest", out.join("\n"));
}

/* ── 启动 ─────────────────────────────────────────────────────── */

function refreshAll() { refreshKeys(); refreshPending(); refreshInstances(); refreshEvents(); }

async function boot() {
  $("pBase").textContent = BASE;
  $("pPoll").textContent = "轮询上限 " + POLL_MAX_MS + "ms";
  $("pCli").textContent = CLI_SERVER ? "php -S（单进程，轮询已缩短）" : "多进程服务器";
  $("pAdminHint").textContent = ADMIN_REQUIRED ? "管理密钥已启用" : "本地测试：管理接口未设密钥";
  try {
    const info = await api("/");
    $("pStatus").textContent = info.name + " · 协议 v" + info.protocol;
    $("pStatus").className = "pill on";
  } catch (e) {
    $("pStatus").textContent = "服务不可达";
    $("pStatus").className = "pill off";
  }
  refreshAll();
  setInterval(() => { if ($("chkAutoRefresh").checked) refreshEvents(); }, 700);
  setInterval(refreshInstances, 3000);
  setInterval(refreshPending, 5000);
}
boot();
</script>
</body>
</html>
HTML;

    $html = str_replace(
        ['__BASE__', '__POLL__', '__CLI__', '__ADMIN__'],
        [
            json_encode($basePath, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
            (string)$pollMaxMs,
            $cliServer ? 'true' : 'false',
            $adminRequired ? 'true' : 'false',
        ],
        $html
    );

    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store');
    echo $html;
}
