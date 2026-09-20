/** Remote terminal operations. The host owns process lifetime and permission checks. */
export function createTerminalOps({ host }) {
  return {
    'terminal.open': (params) => host.terminalOpen(params),
    'terminal.list': () => host.terminalList(),
    'terminal.attach': (params) => host.terminalAttach(params?.terminalId),
    'terminal.keepAlive': (params) => host.terminalKeepAlive(params?.terminalId),
    'terminal.write': (params) => host.terminalWrite(params?.terminalId, params?.data),
    'terminal.resize': (params) => host.terminalResize(params?.terminalId, params?.cols, params?.rows),
    'terminal.close': (params) => host.terminalClose(params?.terminalId),
  }
}
