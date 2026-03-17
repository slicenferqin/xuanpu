import { create } from 'zustand'

export type HintMode = 'idle' | 'pending'

export interface HintTarget {
  kind: 'worktree' | 'plus'
  worktreeId?: string
  projectId: string
}

interface HintStoreState {
  hintMap: Map<string, string>           // id → code (for badge rendering)
  hintTargetMap: Map<string, HintTarget> // id → full target (for action dispatch)
  mode: HintMode
  pendingChar: string | null
  filterActive: boolean                  // true when filter text is non-empty
  inputFocused: boolean                  // true when the search field has focus

  setHints: (map: Map<string, string>, targetMap: Map<string, HintTarget>) => void
  clearHints: () => void
  enterPending: (char: string) => void
  exitPending: () => void
  setFilterActive: (active: boolean) => void
  setInputFocused: (focused: boolean) => void
}

export const useHintStore = create<HintStoreState>()((set) => ({
  hintMap: new Map(),
  hintTargetMap: new Map(),
  mode: 'idle',
  pendingChar: null,
  filterActive: false,
  inputFocused: false,

  setHints: (map, targetMap) => set({ hintMap: map, hintTargetMap: targetMap }),
  clearHints: () => set({ hintMap: new Map(), hintTargetMap: new Map(), mode: 'idle', pendingChar: null }),
  enterPending: (char) => set({ mode: 'pending', pendingChar: char }),
  exitPending: () => set({ mode: 'idle', pendingChar: null }),
  setFilterActive: (active) => set({ filterActive: active }),
  setInputFocused: (focused) => set({ inputFocused: focused }),
}))
