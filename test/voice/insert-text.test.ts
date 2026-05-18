import { insertVoiceText } from '../../src/renderer/src/lib/voice/insert-text'

describe('insertVoiceText', () => {
  it('inserts into an empty composer', () => {
    expect(
      insertVoiceText({
        current: '',
        insert: '创建一个测试',
        selectionStart: 0,
        selectionEnd: 0
      })
    ).toEqual({ value: '创建一个测试', cursor: 6 })
  })

  it('replaces selected text', () => {
    expect(
      insertVoiceText({
        current: 'hello old world',
        insert: 'new',
        selectionStart: 6,
        selectionEnd: 9
      })
    ).toEqual({ value: 'hello new world', cursor: 9 })
  })

  it('adds spacing between ascii words', () => {
    expect(
      insertVoiceText({
        current: 'runTestsnow',
        insert: 'unit',
        selectionStart: 8,
        selectionEnd: 8
      })
    ).toEqual({ value: 'runTests unit now', cursor: 13 })
  })

  it('does not add spacing around Chinese text', () => {
    expect(
      insertVoiceText({
        current: '请实现功能',
        insert: '语音输入',
        selectionStart: 1,
        selectionEnd: 1
      })
    ).toEqual({ value: '请语音输入实现功能', cursor: 5 })
  })
})
