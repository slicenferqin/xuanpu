import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TaskStateManager } from '../src/main/services/xuanpu-agent/task-state-manager'

// Mock the database repository functions
const mockStates = new Map<string, ReturnType<TaskStateManager['initialize']>>()

vi.mock('../src/main/db/task-state-repository', () => ({
  createTaskState: vi.fn((data) => {
    const state = {
      id: 'mock-id',
      taskRunId: data.taskRunId,
      sessionId: data.sessionId,
      objective: data.objective,
      steps: [],
      currentBlocker: null,
      decisions: [],
      relevantContext: [],
      updatedAt: new Date().toISOString()
    }
    mockStates.set(data.taskRunId, state)
    return state
  }),
  getTaskState: vi.fn((taskRunId) => {
    return mockStates.get(taskRunId) ?? null
  }),
  addStep: vi.fn((taskRunId, step) => {
    const state = mockStates.get(taskRunId)
    if (state) {
      state.steps.push(step)
      state.updatedAt = new Date().toISOString()
    }
    return state
  }),
  addDecision: vi.fn((taskRunId, decision) => {
    const state = mockStates.get(taskRunId)
    if (state) {
      state.decisions.push(decision)
      state.updatedAt = new Date().toISOString()
    }
    return state
  }),
  addContext: vi.fn((taskRunId, context) => {
    const state = mockStates.get(taskRunId)
    if (state) {
      state.relevantContext.push(context)
      state.updatedAt = new Date().toISOString()
    }
    return state
  }),
  setBlocker: vi.fn((taskRunId, blocker) => {
    const state = mockStates.get(taskRunId)
    if (state) {
      state.currentBlocker = blocker
      state.updatedAt = new Date().toISOString()
    }
    return state
  })
}))

describe('TaskStateManager POC', () => {
  let manager: TaskStateManager
  let testTaskRunId: string
  let testSessionId: string

  beforeEach(() => {
    mockStates.clear()
    testTaskRunId = `test-task-run-${Date.now()}`
    testSessionId = `test-session-${Date.now()}`
    manager = new TaskStateManager({
      taskRunId: testTaskRunId,
      sessionId: testSessionId,
      objective: 'Test task objective'
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('should initialize a task state', () => {
    const state = manager.initialize('Test task objective')
    
    expect(state).toBeDefined()
    expect(state.taskRunId).toBe(testTaskRunId)
    expect(state.sessionId).toBe(testSessionId)
    expect(state.objective).toBe('Test task objective')
    expect(state.steps).toEqual([])
    expect(state.currentBlocker).toBeNull()
    expect(state.decisions).toEqual([])
    expect(state.relevantContext).toEqual([])
  })

  it('should get existing task state', () => {
    manager.initialize('Test task objective')
    const state = manager.getState()
    
    expect(state).toBeDefined()
    expect(state?.taskRunId).toBe(testTaskRunId)
  })

  it('should update state from turn info', () => {
    manager.initialize('Test task objective')
    
    const turnInfo = {
      userMessage: 'Please implement feature X',
      assistantMessage: 'I decided to implement feature X using approach A',
      toolCalls: [
        {
          name: 'read_file',
          args: { path: '/src/feature.ts' },
          result: 'File content here...'
        }
      ],
      filesChanged: ['/src/feature.ts'],
      errors: []
    }

    const updatedState = manager.updateFromTurn(turnInfo)
    
    expect(updatedState).toBeDefined()
    expect(updatedState?.steps.length).toBe(1)
    expect(updatedState?.steps[0].description).toBe('Execute read_file')
    expect(updatedState?.decisions.length).toBeGreaterThan(0)
    expect(updatedState?.relevantContext.length).toBe(1)
    expect(updatedState?.relevantContext[0].type).toBe('file')
  })

  it('should handle errors and set blocker', () => {
    manager.initialize('Test task objective')
    
    const turnInfo = {
      userMessage: 'Fix the bug',
      assistantMessage: 'I found the issue',
      toolCalls: [],
      filesChanged: [],
      errors: ['TypeError: Cannot read property of undefined']
    }

    const updatedState = manager.updateFromTurn(turnInfo)
    
    expect(updatedState?.currentBlocker).toBe('TypeError: Cannot read property of undefined')
  })

  it('should build context summary', () => {
    manager.initialize('Implement feature X')
    
    const turnInfo = {
      userMessage: 'Please implement feature X',
      assistantMessage: 'I decided to implement feature X using approach A',
      toolCalls: [
        {
          name: 'read_file',
          args: { path: '/src/feature.ts' },
          result: 'File content here...'
        }
      ],
      filesChanged: ['/src/feature.ts'],
      errors: []
    }

    manager.updateFromTurn(turnInfo)
    const summary = manager.buildContextSummary()
    
    expect(summary).toContain('## Task Objective')
    expect(summary).toContain('Implement feature X')
    expect(summary).toContain('## Recent Steps')
    expect(summary).toContain('## Key Decisions')
    expect(summary).toContain('## Relevant Context')
  })

  it('should handle multiple turns', () => {
    manager.initialize('Implement feature X')
    
    // First turn
    manager.updateFromTurn({
      userMessage: 'Start implementing',
      assistantMessage: 'I will start by reading the code',
      toolCalls: [
        {
          name: 'read_file',
          args: { path: '/src/index.ts' },
          result: 'Index file content...'
        }
      ],
      filesChanged: [],
      errors: []
    })

    // Second turn
    const updatedState = manager.updateFromTurn({
      userMessage: 'Continue implementing',
      assistantMessage: 'I decided to use a different approach',
      toolCalls: [
        {
          name: 'write_file',
          args: { path: '/src/feature.ts', content: '...' },
          result: 'File written successfully'
        }
      ],
      filesChanged: ['/src/feature.ts'],
      errors: []
    })

    expect(updatedState?.steps.length).toBe(2)
    expect(updatedState?.decisions.length).toBeGreaterThan(0)
    expect(updatedState?.relevantContext.length).toBeGreaterThan(0)
  })
})
