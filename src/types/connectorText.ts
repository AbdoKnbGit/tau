/**
 * Connector-text content blocks.
 *
 * A `connector_text` block is the streamed narration a connector emits
 * alongside its work. It arrives on the same content-block channel as `text`
 * and `thinking`, but carries its payload on `connector_text` rather than
 * `text`, so it needs its own predicate wherever blocks are walked.
 *
 * Every consumer gates on `feature('CONNECTOR_TEXT')` before calling the
 * predicate, so with the feature off these blocks never appear and the
 * predicate simply never matches.
 */

/** A streamed connector narration block. */
export type ConnectorTextBlock = {
  type: 'connector_text'
  connector_text: string
  /** Present on signature-bearing blocks; opaque, forwarded verbatim. */
  signature?: string
}

/** The incremental delta that appends to a {@link ConnectorTextBlock}. */
export type ConnectorTextDelta = {
  type: 'connector_text_delta'
  connector_text: string
}

/**
 * True for a `connector_text` content block.
 *
 * Takes `unknown` because callers apply it to raw stream payloads and to
 * SDK-typed content blocks alike, neither of which has this block in its
 * union.
 */
export function isConnectorTextBlock(
  block: unknown,
): block is ConnectorTextBlock {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: unknown }).type === 'connector_text'
  )
}
