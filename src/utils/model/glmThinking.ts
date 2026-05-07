/**
 * GLM thinking-mode toggle.
 *
 * BigModel supports `thinking.type` on the GLM 4.7 and GLM 5 families.
 * The model picker owns this state so GLM behaves like DeepSeek V4: the
 * visible `Thinking ON/OFF` row control decides the request payload instead
 * of the hidden /thinking command.
 */

const GLM_THINKING_MODELS: ReadonlySet<string> = new Set([
  'glm-5.1',
  'glm-5-turbo',
  'glm-5',
  'glm-4.7',
])

let _glmThinkingEnabled = false

export function isGlmThinkingModel(model: string): boolean {
  return GLM_THINKING_MODELS.has(model.trim().toLowerCase())
}

export function getGlmThinking(): boolean {
  return _glmThinkingEnabled
}

export function setGlmThinking(enabled: boolean): void {
  _glmThinkingEnabled = enabled
}

export function toggleGlmThinking(): boolean {
  _glmThinkingEnabled = !_glmThinkingEnabled
  return _glmThinkingEnabled
}
