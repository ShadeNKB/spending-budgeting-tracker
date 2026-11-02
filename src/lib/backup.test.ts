import { describe, expect, it } from 'vitest'
import { isNumber, isRecord, isString, listOf, recordOf } from './backup'
import source from './backup.ts?raw'

describe('guards', () => {
  it('isRecord accepts plain objects only', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord(null)).toBe(false)
    expect(isRecord([])).toBe(false)
    expect(isRecord('x')).toBe(false)
  })

  it('listOf keeps well-typed items and turns non-arrays into []', () => {
    expect(listOf(['a', 1, null, 'b'], isString)).toEqual(['a', 'b'])
    expect(listOf({ 0: 'a' }, isString)).toEqual([])
    expect(listOf(null, isString)).toEqual([])
  })

  it('recordOf keeps well-typed entries and turns non-objects into {}', () => {
    expect(recordOf({ coffee: 'Food', bad: 3 }, isString)).toEqual({ coffee: 'Food' })
    expect(recordOf({ Food: 200, Travel: '300' }, isNumber)).toEqual({ Food: 200 })
    expect(recordOf(null, isString)).toEqual({})
    expect(recordOf(['Food'], isString)).toEqual({})
    expect(recordOf('Food', isString)).toEqual({})
  })

  it('recordOf keeps a key named "__proto__" as a plain own key', () => {
    const read = recordOf(JSON.parse('{"__proto__":"Meals","kopi":"Meals","bad":1}'), isString)
    expect(Object.keys(read)).toEqual(['__proto__', 'kopi'])
    expect(Object.hasOwn(read, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(read)).toBe(Object.prototype)
    expect(JSON.stringify(read)).toBe('{"__proto__":"Meals","kopi":"Meals"}')
  })
})

describe('backup files are read by the data core', () => {
  it('keeps no parser of its own (import goes through decodeWire and planImport)', () => {
    expect(source).not.toMatch(/parseBackup|BackupTooLargeError|MAX_IMPORT_EXPENSES/)
  })
})
