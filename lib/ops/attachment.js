/**
 * `attachment.*`: uploads and reads for the composer's `+` button and for the
 * image and file cards in a rendered transcript (PLUGIN-EXT §4).
 *
 * The server uploads one file at a time, serially, with no chunking; the
 * harness stores the bytes and this bridge only remembers which durable
 * reference an `attachmentId` names. `session.prompt` then refers to those ids
 * and the host layer turns them back into the parts the prompt path consumes.
 *
 * @module dsh2server/lib/ops/attachment
 */

import { ERROR_CODES, fail } from '../protocol.js'
import { optionalInt, optionalString, requireString } from './params.js'

/** Largest single upload, before base64 expansion. */
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

/** Largest base64 payload accepted, so an oversized body is refused before decoding. */
const MAX_BASE64_LENGTH = 11 * 1024 * 1024

/** Ceiling for one `attachment.get` window. */
const MAX_READ_BYTES = 16 * 1024 * 1024

/**
 * @param {object} deps operation dependencies.
 * @returns {Record<string, Function>} the attachment handlers.
 */
export function createAttachmentOps(deps) {
  const { host } = deps
  return {
    /**
     * Store one uploaded attachment and hand back the id the server refers to
     * it by. Images are normalized by the harness; files are stored verbatim.
     */
    'attachment.put': async (params, ctx) => {
      const name = optionalString(params, 'name', { maxLength: 512 }) ?? 'attachment'
      const mime = optionalString(params, 'mime', { maxLength: 200 }) ?? 'application/octet-stream'
      const dataBase64 = requireString(params, 'dataBase64', { maxLength: MAX_BASE64_LENGTH })
      const bytes = Math.floor((dataBase64.length * 3) / 4)
      if (bytes > MAX_ATTACHMENT_BYTES) {
        throw fail(
          ERROR_CODES.PAYLOAD_TOO_LARGE,
          `attachment is about ${bytes} bytes, above the ${MAX_ATTACHMENT_BYTES}-byte upload limit`,
          { details: { bytes, maxBytes: MAX_ATTACHMENT_BYTES } },
        )
      }
      return await host.putAttachment({ name, mime, dataBase64 }, ctx.signal)
    },

    /**
     * Read one stored attachment back as base64, so a server can render an
     * image or hand the file to its own viewer. Nothing is ever truncated: a
     * payload over `maxBytes` is refused, because a silently shortened file
     * reads as a corrupt one.
     */
    'attachment.get': async (params, ctx) => {
      const attachmentId = requireString(params, 'attachmentId', { maxLength: 200 })
      const maxBytes = optionalInt(params, 'maxBytes', 1, MAX_READ_BYTES)
      return await host.getAttachment({ attachmentId, maxBytes }, ctx.signal)
    },
  }
}
