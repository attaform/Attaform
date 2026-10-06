/**
 * The focused element in `node`'s tree. Read off the rootNode, so a control
 * inside a shadow tree resolves too: there `document.activeElement` is the
 * shadow host.
 */
export function activeElementOf(node: Node): Element | null {
  const rootNode = node.getRootNode()
  return rootNode instanceof Document || rootNode instanceof ShadowRoot
    ? rootNode.activeElement
    : null
}
