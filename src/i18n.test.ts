import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectLocale } from './i18n.ts'

const known = ['en', 'zh']

test('selectLocale prefers ?lang= over the system language', () => {
  assert.equal(selectLocale('?lang=en', 'zh-CN', known), 'en')
  assert.equal(selectLocale('?lang=zh', 'en-US', known), 'zh')
  assert.equal(selectLocale('?lang=en&boot=shell', 'zh-CN', known), 'en')
  assert.equal(selectLocale('?lang=en-GB', 'zh-CN', known), 'en')
  assert.equal(selectLocale('?lang=zh-Hans-CN', 'en-US', known), 'zh')
})

test('selectLocale uses the system language, then English', () => {
  assert.equal(selectLocale('', 'zh-CN', known), 'zh')
  assert.equal(selectLocale('?boot=shell', 'en-US', known), 'en')
  assert.equal(selectLocale('', 'fr-FR', known), 'en')
  assert.equal(selectLocale('?lang=', 'zh-CN', known), 'zh')
  assert.equal(selectLocale('?lang=nope', 'zh-CN', known), 'zh')
  assert.equal(selectLocale('?lang=%%%', 'fr-FR', known), 'en')
  assert.equal(selectLocale('?lang=EN', 'fr-FR', known), 'en')
})
