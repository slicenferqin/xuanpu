export const SHOW_XUANPU_AGENT_DEBUG_UI =
  typeof process !== 'undefined' &&
  (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test')
