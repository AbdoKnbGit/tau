import type { CdpClient } from './cdp.js'

export interface FrameScope {
  sessionId: string
  contextId?: number
  frameId?: string
}

type FrameTree = { frame: { id: string; parentId?: string }; childFrames?: FrameTree[] }
type FrameContext = { id: number; frameId: string }

/** Main-world execution contexts stay private to the connection, never in tool schemas. */
export class FrameRouter {
  private owners = new Map<string, string>()
  private roots = new Map<string, string>()
  private contexts = new Map<string, Map<number, FrameContext>>()
  private parents = new Map<string, string>()
  private focused = new Map<string, string>()
  private attachments = new Map<string, Promise<string>>()
  private trees = new Map<string, Set<string>>()
  private epochs = new Map<string, number>()

  constructor(private client: CdpClient) {
    client.on('Runtime.executionContextCreated', ((p: { context: { id: number; auxData?: { frameId?: string; isDefault?: boolean } } }, sessionId?: string) => {
      const { context } = p
      if (!sessionId || !context.auxData?.isDefault || !context.auxData.frameId) return
      let entries = this.contexts.get(sessionId)
      if (!entries) this.contexts.set(sessionId, entries = new Map())
      entries.set(context.id, { id: context.id, frameId: context.auxData.frameId })
    }) as never)
    client.on('Runtime.executionContextDestroyed', ((p: { executionContextId: number }, sessionId?: string) => {
      if (sessionId) this.contexts.get(sessionId)?.delete(p.executionContextId)
    }) as never)
    client.on('Runtime.executionContextsCleared', ((_p: unknown, sessionId?: string) => {
      if (sessionId) this.contexts.delete(sessionId)
    }) as never)
    client.on('Page.frameAttached', ((p: { frameId: string; parentFrameId: string }) => {
      this.parents.set(p.frameId, p.parentFrameId)
    }) as never)
    client.on('Page.frameNavigated', ((p: { frame: { id: string; parentId?: string } }, sessionId?: string) => {
      if (p.frame.parentId) this.parents.set(p.frame.id, p.frame.parentId)
      const owner = sessionId && this.owners.get(sessionId)
      if (owner && this.roots.get(owner) === sessionId && !p.frame.parentId) this.top(owner)
      else if (owner && this.focused.has(owner)) {
        let current = this.focused.get(owner)
        const seen = new Set<string>()
        while (current && !seen.has(current)) {
          if (current === p.frame.id) { this.epochs.set(owner, (this.epochs.get(owner) ?? 0) + 1); break }
          seen.add(current)
          current = this.parents.get(current)
        }
      }
    }) as never)
    client.on('Page.frameDetached', ((p: { frameId: string; reason?: string }) => {
      // A process swap keeps the frame identity; a removal makes it unreachable.
      if (p.reason === 'swap') return
      const removed = new Set([p.frameId])
      for (let changed = true; changed;) {
        changed = false
        for (const [child, parent] of this.parents) if (removed.has(parent) && !removed.has(child)) {
          removed.add(child)
          changed = true
        }
      }
      for (const frameId of removed) this.parents.delete(frameId)
      for (const entries of this.contexts.values()) {
        for (const [id, context] of entries) if (removed.has(context.frameId)) entries.delete(id)
      }
      for (const tree of this.trees.values()) for (const frameId of removed) tree.delete(frameId)
      for (const [targetId, selected] of this.focused) if (removed.has(selected)) this.epochs.set(targetId, (this.epochs.get(targetId) ?? 0) + 1)
    }) as never)
    client.on('Target.detachedFromTarget', ((p: { sessionId: string }) => {
      const owner = this.owners.get(p.sessionId)
      if (owner && this.focused.has(owner)) this.epochs.set(owner, (this.epochs.get(owner) ?? 0) + 1)
      this.contexts.delete(p.sessionId)
      this.trees.delete(p.sessionId)
      this.owners.delete(p.sessionId)
    }) as never)
  }

  registerTop(targetId: string, sessionId: string): void {
    this.roots.set(targetId, sessionId)
    this.owners.set(sessionId, targetId)
  }

  selected(targetId: string): string | undefined { return this.focused.get(targetId) }
  guard(targetId: string): () => void {
    const epoch = this.epochs.get(targetId) ?? 0
    const focus = this.focused.get(targetId)
    const root = this.roots.get(targetId)
    return () => {
      if (this.roots.get(targetId) !== root || (this.epochs.get(targetId) ?? 0) !== epoch || this.focused.get(targetId) !== focus) {
        throw new Error('frame_unreachable: the frame or tab changed during input preparation.')
      }
    }
  }
  top(targetId: string): void {
    this.focused.delete(targetId)
    this.epochs.set(targetId, (this.epochs.get(targetId) ?? 0) + 1)
  }
  forget(targetId: string): void {
    this.top(targetId)
    this.roots.delete(targetId)
    for (const [sessionId, owner] of this.owners) if (owner === targetId) {
      this.contexts.delete(sessionId)
      this.trees.delete(sessionId)
      this.owners.delete(sessionId)
    }
  }

  private async readTree(sessionId: string): Promise<string> {
    const { frameTree } = await this.client.send<{ frameTree: FrameTree }>('Page.getFrameTree', {}, sessionId)
    const ids = new Set<string>()
    const visit = (tree: FrameTree, parent?: string) => {
      ids.add(tree.frame.id)
      if (parent || tree.frame.parentId) this.parents.set(tree.frame.id, parent ?? tree.frame.parentId!)
      for (const child of tree.childFrames ?? []) visit(child, tree.frame.id)
    }
    visit(frameTree)
    this.trees.set(sessionId, ids)
    return frameTree.frame.id
  }

  private knownScope(targetId: string, frameId: string): FrameScope | undefined {
    for (const [sessionId, entries] of this.contexts) {
      if (this.owners.get(sessionId) !== targetId) continue
      for (const context of entries.values()) if (context.frameId === frameId) {
        return { sessionId, contextId: context.id, frameId }
      }
    }
    return undefined
  }

  private async scopeFor(targetId: string, frameId: string): Promise<FrameScope> {
    const known = this.knownScope(targetId, frameId)
    if (known) return known
    // Chromium names each out-of-process iframe target with its frame id.
    let pending = this.attachments.get(frameId)
    if (!pending) {
      pending = (async () => {
        const { sessionId } = await this.client.send<{ sessionId: string }>('Target.attachToTarget', { targetId: frameId, flatten: true })
        this.owners.set(sessionId, targetId)
        try {
          await this.client.send('Page.enable', {}, sessionId)
          if (await this.readTree(sessionId) !== frameId) throw new Error('Frame identity changed.')
          await this.client.send('Runtime.enable', {}, sessionId)
          return sessionId
        } catch (error) {
          this.owners.delete(sessionId)
          await this.client.send('Target.detachFromTarget', { sessionId }).catch(() => undefined)
          throw error
        }
      })()
      this.attachments.set(frameId, pending)
    }
    try {
      await pending
    } catch {
      throw new Error('frame_unreachable: the selected iframe is gone, loading, or blocks scripts; use frame without ref to return to the page.')
    } finally {
      if (this.attachments.get(frameId) === pending) this.attachments.delete(frameId)
    }
    const scope = this.knownScope(targetId, frameId)
    if (!scope) throw new Error('frame_unreachable: the iframe has no live execution context; return to the page with frame without ref.')
    return scope
  }

  async enter(targetId: string, frameId: string): Promise<void> {
    const root = this.roots.get(targetId)
    if (!root) throw new Error('frame_unreachable: the tab is no longer attached.')
    const epoch = this.epochs.get(targetId) ?? 0
    await this.readTree(root)
    const current = this.focused.get(targetId)
    const parentScope = current ? await this.scopeFor(targetId, current) : { sessionId: root }
    if (parentScope.sessionId !== root) await this.readTree(parentScope.sessionId)
    if (!this.trees.get(parentScope.sessionId)?.has(frameId)) {
      // Page.getFrameTree can omit a remote-process child. Verify its live DOM
      // owner in the current parent session instead of accepting a stale context.
      await this.discoverParent(frameId, parentScope)
    }
    const scope = await this.scopeFor(targetId, frameId)
    // No changes to focus until the destination is proven reachable.
    const proof = await this.client.send<{ result?: { value?: boolean }; exceptionDetails?: unknown }>('Runtime.evaluate', { expression: 'document.documentElement !== null', returnByValue: true, contextId: scope.contextId }, scope.sessionId)
    if (proof.exceptionDetails || proof.result?.value !== true || this.roots.get(targetId) !== root || (this.epochs.get(targetId) ?? 0) !== epoch) {
      throw new Error('frame_unreachable: the frame or tab changed while entering it.')
    }
    this.focused.set(targetId, frameId)
  }

  private async discoverParent(frameId: string, scope: FrameScope): Promise<void> {
    let objectId: string | undefined
    let documentId: string | undefined
    try {
      const owner = await this.client.send<{ backendNodeId?: number }>('DOM.getFrameOwner', { frameId }, scope.sessionId)
      if (!owner.backendNodeId) throw new Error('No frame owner.')
      const resolved = await this.client.send<{ object?: { objectId?: string } }>('DOM.resolveNode', { backendNodeId: owner.backendNodeId }, scope.sessionId)
      objectId = resolved.object?.objectId
      if (!objectId) throw new Error('No live owner.')
      const reply = await this.client.send<{ result?: { objectId?: string } }>('Runtime.callFunctionOn', {
        objectId, functionDeclaration: 'function(){ return this.isConnected && /^(IFRAME|FRAME)$/.test(this.tagName) ? this.ownerDocument : null; }', returnByValue: false,
      }, scope.sessionId)
      documentId = reply.result?.objectId
      if (!documentId) throw new Error('Detached frame owner.')
      const { node } = await this.client.send<{ node: { backendNodeId: number } }>('DOM.describeNode', { objectId: documentId }, scope.sessionId)
      // Document nodes expose a backend identity, not a frameId. Match it to
      // the main-world documents already reported by Runtime, never by URL.
      let parentId: string | undefined
      for (const context of this.contexts.get(scope.sessionId)?.values() ?? []) {
        const candidate = await this.client.send<{ result?: { objectId?: string } }>('Runtime.evaluate', { expression: 'document', contextId: context.id, returnByValue: false }, scope.sessionId)
        const id = candidate.result?.objectId
        if (!id) continue
        try {
          const described = await this.client.send<{ node: { backendNodeId: number } }>('DOM.describeNode', { objectId: id }, scope.sessionId)
          if (node.backendNodeId === described.node.backendNodeId) { parentId = context.frameId; break }
        } finally {
          await this.client.send('Runtime.releaseObject', { objectId: id }, scope.sessionId).catch(() => undefined)
        }
      }
      if (!parentId || parentId === frameId) throw new Error('Missing parent identity.')
      this.parents.set(frameId, parentId)
    } catch {
      throw new Error('frame_unreachable: the iframe is absent from the current document.')
    } finally {
      for (const id of [objectId, documentId]) if (id) await this.client.send('Runtime.releaseObject', { objectId: id }, scope.sessionId).catch(() => undefined)
    }
  }

  async runtime(targetId: string, rootSession: string): Promise<FrameScope> {
    const frameId = this.focused.get(targetId)
    return frameId ? this.scopeFor(targetId, frameId) : { sessionId: rootSession }
  }

  /** Parent viewport geometry, checked anew before each physical pointer input. */
  private async ownerGeometry(targetId: string, child: string, point?: { x: number; y: number }, scroll = false): Promise<{
    x: number; y: number; sx: number; sy: number; width: number; height: number; covered?: boolean
  }> {
    const parent = this.parents.get(child)
    if (!parent) throw new Error('frame_unreachable: the iframe was detached.')
    const scope = await this.scopeFor(targetId, parent)
    const { backendNodeId } = await this.client.send<{ backendNodeId: number }>('DOM.getFrameOwner', { frameId: child }, scope.sessionId)
    const { object } = await this.client.send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId, executionContextId: scope.contextId }, scope.sessionId)
    if (!object.objectId) throw new Error('frame_unreachable: the iframe owner disappeared.')
    try {
      const reply = await this.client.send<{ result?: { value?: ReturnTypeShape }; exceptionDetails?: unknown }>('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function(point, scroll) {
          if (!this.isConnected) return null;
          if (scroll) this.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
          const win = this.ownerDocument.defaultView;
          // Rotation/perspective need a projective transform, not a guessed offset.
          for (let node=this; node; node=node.parentElement || node.getRootNode()?.host) {
            const style=win.getComputedStyle(node);
            if (style.perspective !== 'none' || (style.rotate && style.rotate !== 'none' && style.rotate !== '0deg')) return null;
            if (style.transform && style.transform !== 'none') {
              const m=new win.DOMMatrixReadOnly(style.transform);
              if (!m.is2D || Math.abs(m.b)>0.0001 || Math.abs(m.c)>0.0001 || m.a<=0 || m.d<=0) return null;
            }
          }
          const r=this.getBoundingClientRect(), sx=r.width/this.offsetWidth, sy=r.height/this.offsetHeight;
          if (!(sx>0 && sy>0 && this.clientWidth>0 && this.clientHeight>0)) return null;
          const x=r.left+this.clientLeft*sx, y=r.top+this.clientTop*sy;
          let covered=false;
          if (point) {
            const px=x+point.x*sx, py=y+point.y*sy;
            let hit=this.ownerDocument.elementFromPoint(px,py);
            while (hit?.shadowRoot) { const next=hit.shadowRoot.elementFromPoint(px,py); if(!next||next===hit)break; hit=next; }
            covered=point.x<0||point.y<0||point.x>this.clientWidth||point.y>this.clientHeight||hit!==this;
          }
          return {x,y,sx,sy,width:this.clientWidth,height:this.clientHeight,covered};
        }`,
        arguments: [{ value: point ?? null }, { value: scroll }],
        returnByValue: true,
      }, scope.sessionId)
      if (reply.exceptionDetails || !reply.result?.value) throw new Error('frame_unreachable: iframe geometry is detached or uses an unsupported transform.')
      return reply.result.value
    } finally {
      await this.client.send('Runtime.releaseObject', { objectId: object.objectId }, scope.sessionId).catch(() => undefined)
    }
  }

  async reveal(targetId: string): Promise<void> {
    const check = this.guard(targetId)
    const chain = this.chain(targetId)
    for (const child of chain.reverse()) {
      await this.ownerGeometry(targetId, child, undefined, true)
      check()
    }
  }

  private chain(targetId: string): string[] {
    const chain: string[] = []
    let child = this.focused.get(targetId)
    const seen = new Set<string>()
    while (child && this.parents.has(child)) {
      if (seen.has(child) || chain.length >= 16) throw new Error('frame_unreachable: invalid iframe ancestry.')
      seen.add(child)
      chain.push(child)
      child = this.parents.get(child)
    }
    if (chain.length === 0 && this.focused.has(targetId)) throw new Error('frame_unreachable: the iframe was removed.')
    return chain
  }

  async point(targetId: string, x: number, y: number, checkCoverage = true): Promise<{ x: number; y: number }> {
    const check = this.guard(targetId)
    for (const child of this.chain(targetId)) {
      const geometry = await this.ownerGeometry(targetId, child, { x, y })
      check()
      if (checkCoverage && geometry.covered) throw new Error('element_covered: a parent page covers or clips the selected iframe; return to the page to inspect it.')
      x = geometry.x + x * geometry.sx
      y = geometry.y + y * geometry.sy
    }
    check()
    return { x, y }
  }
}

type ReturnTypeShape = { x: number; y: number; sx: number; sy: number; width: number; height: number; covered?: boolean }
