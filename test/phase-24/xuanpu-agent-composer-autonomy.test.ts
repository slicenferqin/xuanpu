import { describe, expect, it } from 'vitest'

import {
  inferXuanpuAgentTaskRunAutonomyDirective,
  mergeXuanpuAgentAutonomyDirective
} from '../../src/renderer/src/lib/xuanpu-agent-autonomy-directive'

describe('xuanpu-agent composer autonomy directive', () => {
  it('infers explicit long task-run directives from composer text', () => {
    expect(
      inferXuanpuAgentTaskRunAutonomyDirective(
        '请按 long task run 执行一次分阶段审计',
        'xuanpu-agent'
      )
    ).toBe('long')

    expect(
      inferXuanpuAgentTaskRunAutonomyDirective(
        '按 long autonomy 执行。没做完不要停',
        'xuanpu-agent'
      )
    ).toBe('long')

    expect(inferXuanpuAgentTaskRunAutonomyDirective('继续吧，长任务执行', 'xuanpu-agent')).toBe(
      'long'
    )

    expect(inferXuanpuAgentTaskRunAutonomyDirective('按隔夜任务跑完整验收', 'xuanpu-agent')).toBe(
      'overnight'
    )

    expect(
      inferXuanpuAgentTaskRunAutonomyDirective('/overnight 继续跑完整测试', 'xuanpu-agent')
    ).toBe('overnight')
  })

  it('does not infer directives for other runtimes or ordinary prose', () => {
    expect(
      inferXuanpuAgentTaskRunAutonomyDirective('解释一下 long task run 是什么', 'xuanpu-agent')
    ).toBeNull()
    expect(
      inferXuanpuAgentTaskRunAutonomyDirective('解释一下长任务执行是什么意思', 'xuanpu-agent')
    ).toBeNull()
    expect(inferXuanpuAgentTaskRunAutonomyDirective('按 long task run 执行', 'codex')).toBeNull()
    expect(inferXuanpuAgentTaskRunAutonomyDirective('请继续', 'xuanpu-agent')).toBeNull()
  })

  it('merges inferred autonomy into existing prompt options', () => {
    expect(
      mergeXuanpuAgentAutonomyDirective('请按 long task run 执行', 'xuanpu-agent', {
        mode: 'build'
      })
    ).toEqual({ mode: 'build', taskRunAutonomy: 'long' })
  })
})
