import React, { type ReactNode } from 'react'
import { Text } from '../ink.js'

function normalize(content: ReactNode): ReactNode {
  if (typeof content === 'string' || typeof content === 'number' || typeof content === 'bigint')
    return <Text>{String(content)}</Text>
  if (Array.isArray(content) || (content && typeof content === 'object' && Symbol.iterator in content))
    return React.Children.map(content, normalize)
  if (React.isValidElement<{ children?: ReactNode }>(content) && content.type === React.Fragment)
    return React.cloneElement(content, undefined, normalize(content.props.children))
  return content
}

/** Tool callbacks accept ReactNode, while bare terminal text needs a Text parent. */
export function ToolRendererContent({ children }: { children: ReactNode }): ReactNode {
  return normalize(children)
}
