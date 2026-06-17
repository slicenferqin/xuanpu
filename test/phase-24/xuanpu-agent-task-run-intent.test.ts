import {
  analyzeTaskRunIntent,
  inferTaskRunAutonomyFromPromptText
} from '../../src/main/services/xuanpu-agent/task-run-intent'

describe('xuanpu-agent task-run intent analysis', () => {
  it('honors explicit autonomy requests before scoring prompt shape', () => {
    expect(inferTaskRunAutonomyFromPromptText('/long task run 执行一次审计')).toBe('long')
    expect(inferTaskRunAutonomyFromPromptText('请按 overnight autonomy 跑完整验收')).toBe(
      'overnight'
    )
    expect(inferTaskRunAutonomyFromPromptText('继续吧，长任务执行')).toBe('long')
    expect(inferTaskRunAutonomyFromPromptText('按隔夜任务跑完整验收')).toBe('overnight')
    expect(inferTaskRunAutonomyFromPromptText('#short 解释一下当前结构')).toBe('short')
  })

  it('classifies realistic document packages as long tasks', () => {
    const analysis = analyzeTaskRunIntent(
      [
        '帮我基于当前仓库代码，整理一套 xuanpu-agent task-run 机制的内部工程文档包。文档要求：',
        '- 先读取相关源码或测试文件，再写文档。',
        '- 文档里要引用实际文件路径，例如 src/main/services/xuanpu-agent/task-run-policy.ts。',
        '- 每份文档要包含：背景、关键流程、相关代码、常见故障、验证方式。',
        '- 写完每份后更新 manifest.json，记录文件路径、主题、估算字符数、状态、引用过的源码文件。',
        '- 如果某份还没写完，manifest.json 里要标记 partial，不要假装完成。',
        '- 完成全部后，生成 README.md 作为入口索引。'
      ].join('\n')
    )

    expect(analysis.autonomy).toBe('long')
    expect(analysis.confidence).toBe('strong')
    expect(analysis.signals).toEqual(
      expect.arrayContaining([
        'documentation-package',
        'multiple-artifacts',
        'source-grounded-writing',
        'manifest-tracking',
        'readme-index'
      ])
    )
  })

  it('classifies multi-step code review and fix requests as long tasks', () => {
    const analysis = analyzeTaskRunIntent(
      '看下最近的提交代码，cr一下，出一份诊断报告，如果问题不需要我确认的话，就可以随手修掉'
    )

    expect(analysis.autonomy).toBe('long')
    expect(analysis.confidence).toBe('strong')
    expect(analysis.signals).toEqual(
      expect.arrayContaining(['code-review', 'diagnostic-report', 'opportunistic-fix'])
    )
  })

  it('does not upgrade ordinary questions or single-file edits to long tasks', () => {
    expect(inferTaskRunAutonomyFromPromptText('解释一下当前架构')).toBeNull()
    expect(inferTaskRunAutonomyFromPromptText('解释一下长任务执行是什么意思')).toBeNull()
    expect(
      inferTaskRunAutonomyFromPromptText('帮我更新 README.md，补一段 task-run 简介')
    ).toBeNull()
    expect(
      inferTaskRunAutonomyFromPromptText('帮我生成 manifest.json，列出当前目录里的 markdown 文件')
    ).toBeNull()
  })
})
