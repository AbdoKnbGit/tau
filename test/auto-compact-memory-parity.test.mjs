import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {transformSync} from 'esbuild'
import {test} from 'node:test'

function setup(overflow=false) {
  const calls=[],rows=[{type:'user',uuid:'old',message:{content:'old'}}]
  const memory=()=>({boundaryMarker:{type:'system',subtype:'compact_boundary',uuid:'boundary',compactMetadata:{}},summaryMessages:[{type:'user',uuid:'summary',message:{content:'memory'}}],attachments:[],hookResults:[]})
  class Handles {
    expose(messages){return {messages,rows:messages.filter(m=>m.type==='user').map(m=>({handle:m.uuid,role:'user',text:m.message.content,toolUses:[]}))}}
    restore(_rows,view){return view.messages}
    result(value){return value}
    checkInput(){}
  }
  const deps={CompactMessageHandles:Handles,inToolContext:async(_c,_p,fn)=>fn(),dispatchModEvent:async(_name,e,next)=>next(e),
    cloneFileStateCache:()=>({dump:()=>[]}),executePreCompactHooks:async()=>{calls.push('pre');return {newCustomInstructions:'paid-only instruction'}},
    trySessionMemoryCompaction:async(_m,_id,_threshold,preparation)=>{calls.push(preparation?'memory staged':'memory accepted');return !preparation&&overflow?null:memory()},
    compactConversation:async()=>{calls.push('full');return memory()},
    buildPostCompactMessages:r=>[r.boundaryMarker,...r.summaryMessages,...r.attachments,...r.hookResults],
    processSessionStartHooks:async()=>{calls.push('hooks');return []},executePostCompactHooks:async()=>({}),
    markFullCompactionCommitted:()=>calls.push('commit'),getMainLoopModel:()=> 'native-global-model',
    roughTokenCountEstimationForMessages:()=>123,
  }
  const code=transformSync(readFileSync(new URL('../src/services/compact/modAutoCompact.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs',target:'node20'}).code
  const module={exports:{}};runInNewContext(code,{module,exports:module.exports,require:()=>deps,AbortController,Set,Map},{filename:'modAutoCompact.ts'})
  const context={abortController:new AbortController(),readFileState:{load:()=>{}},loadedNestedMemoryPaths:new Set(),options:{mainLoopModel:'child-model'}}
  return {calls,run:()=>module.exports.runModAutoCompact(rows,context,{}, {autoCompactThreshold:1000},false)}
}
test('a pass-through automatic hook keeps the session-memory fast path and hook ordering',async()=>{
  const s=setup();await s.run()
  assert.deepEqual(s.calls,['memory staged','memory accepted','commit'],'memory must precede PreCompact and accepted hooks use the native memory path')
})
test('session-memory overflow after accepted hooks takes the ordinary full-summary fallback',async()=>{
  const s=setup(true);await s.run()
  assert.deepEqual(s.calls,['memory staged','memory accepted','pre','full','hooks','commit'])
})
