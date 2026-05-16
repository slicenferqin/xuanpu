import {
  appendFunAsrPartialText,
  finalizeFunAsrText,
  parseFunAsrMessage
} from '../../src/shared/lib/voice-funasr'

describe('parseFunAsrMessage', () => {
  it('maps online messages to partial transcript events', () => {
    expect(
      parseFunAsrMessage('s1', {
        mode: '2pass-online',
        text: '创建函数'
      })
    ).toMatchObject({
      sessionId: 's1',
      type: 'partial',
      text: '创建函数'
    })
  })

  it('maps offline messages to final transcript events', () => {
    expect(
      parseFunAsrMessage('s1', {
        mode: '2pass-offline',
        text: '创建函数并运行测试'
      })
    ).toMatchObject({
      sessionId: 's1',
      type: 'final',
      text: '创建函数并运行测试'
    })
  })

  it('ignores empty transcripts', () => {
    expect(parseFunAsrMessage('s1', { mode: '2pass-offline', text: '' })).toBeNull()
  })
})

describe('FunASR transcript text merging', () => {
  it('accumulates incremental online fragments', () => {
    let buffered = ''
    buffered = appendFunAsrPartialText(buffered, '你')
    buffered = appendFunAsrPartialText(buffered, '好玄')
    buffered = appendFunAsrPartialText(buffered, '圃')

    expect(buffered).toBe('你好玄圃')
  })

  it('accepts full-prefix online partial replacements without duplication', () => {
    let buffered = appendFunAsrPartialText('', '你好')
    buffered = appendFunAsrPartialText(buffered, '你好玄圃')

    expect(buffered).toBe('你好玄圃')
  })

  it('uses buffered speech when the offline final only contains punctuation', () => {
    expect(finalizeFunAsrText('你好玄圃', '。')).toBe('你好玄圃。')
  })

  it('prefers full offline final text when it contains the complete utterance', () => {
    expect(finalizeFunAsrText('创建函数', '创建一个测试函数')).toBe('创建一个测试函数')
  })
})
