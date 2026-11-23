// 极简测试脚手架：PASS/FAIL 计数 + 结束码。用法：node tests/xxx.mjs
const results = []

export function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`${mark} ${name}${!ok && detail ? `  -> ${detail}` : ''}`)
}

export function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  check(name, ok, ok ? '' : `expect ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`)
}

export function includes(name, haystack, needle) {
  const ok = typeof haystack === 'string' && haystack.includes(needle)
  check(name, ok, ok ? '' : `missing ${JSON.stringify(needle)}`)
}

export function summary(label) {
  const failed = results.filter((item) => !item.ok)
  console.log(`\n${label}: ${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) {
    for (const item of failed) console.log(`  FAILED: ${item.name} ${item.detail}`)
    process.exitCode = 1
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
