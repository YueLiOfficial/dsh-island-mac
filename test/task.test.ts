import { test } from 'node:test'
import assert from 'node:assert/strict'
import { currentTaskFromTodos, currentTaskFromToolCall, truncateTask } from '../src/task.ts'

test('currentTaskFromTodos 取第一个 in_progress 项的 content', () => {
  assert.equal(
    currentTaskFromTodos({
      todos: [
        { content: '已完成的事', status: 'completed' },
        { content: '正在做的事', status: 'in_progress' },
        { content: '还没做的事', status: 'pending' },
      ],
    }),
    '正在做的事',
  )
})

test('currentTaskFromTodos 无 in_progress 时返回 null', () => {
  assert.equal(
    currentTaskFromTodos({
      todos: [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'pending' },
      ],
    }),
    null,
  )
})

test('currentTaskFromTodos 多项进行中时取第一个（顺序即优先级）', () => {
  assert.equal(
    currentTaskFromTodos({
      todos: [
        { content: '第一件', status: 'in_progress' },
        { content: '第二件', status: 'in_progress' },
      ],
    }),
    '第一件',
  )
})

test('currentTaskFromTodos 畸形载荷一律返回 null 而不抛异常', () => {
  const bad = [
    null,
    undefined,
    42,
    'x',
    {},
    { todos: 'nope' },
    { todos: [] },
    { todos: [null, 1, 'x'] },
    { todos: [{ content: 42, status: 'in_progress' }] },
    { todos: [{ content: '   ', status: 'in_progress' }] },
    { todos: [{ status: 'in_progress' }] },
  ]
  for (const b of bad) {
    assert.doesNotThrow(() => currentTaskFromTodos(b))
    assert.equal(currentTaskFromTodos(b), null, `未对 ${JSON.stringify(b)} 返回 null`)
  }
})

test('currentTaskFromToolCall 输出中文动作 + 关键参数', () => {
  assert.equal(
    currentTaskFromToolCall('Bash', JSON.stringify({ command: 'pnpm test', description: '运行测试' })),
    '运行测试',
  )
  assert.equal(
    currentTaskFromToolCall('Bash', JSON.stringify({ command: 'pnpm test' })),
    '执行命令：pnpm test',
  )
  assert.equal(
    currentTaskFromToolCall('Read', JSON.stringify({ file_path: 'src/index.ts' })),
    '查看文件：src/index.ts',
  )
  assert.equal(
    currentTaskFromToolCall('Write', JSON.stringify({ file_path: 'src/a.ts' })),
    '写入文件：src/a.ts',
  )
  assert.equal(
    currentTaskFromToolCall('Edit', JSON.stringify({ file_path: 'src/a.ts' })),
    '修改文件：src/a.ts',
  )
  assert.equal(
    currentTaskFromToolCall('Glob', JSON.stringify({ pattern: '**/*.ts' })),
    '查找文件：**/*.ts',
  )
  assert.equal(
    currentTaskFromToolCall('Grep', JSON.stringify({ pattern: 'TODO' })),
    '搜索内容：TODO',
  )
  assert.equal(
    currentTaskFromToolCall('WebSearch', JSON.stringify({ query: 'swiftui hover' })),
    '搜索网页：swiftui hover',
  )
  assert.equal(
    currentTaskFromToolCall('WebFetch', JSON.stringify({ url: 'https://example.com/a' })),
    '抓取网页：https://example.com/a',
  )
  assert.equal(
    currentTaskFromToolCall('TodoWrite', JSON.stringify({ todos: [] })),
    '整理任务清单',
  )
  assert.equal(
    currentTaskFromToolCall('ReportProgress', JSON.stringify({ percent: 0.5 })),
    '上报进度',
  )
})

test('currentTaskFromToolCall：工具名大小写与常见别名都要认', () => {
  assert.equal(currentTaskFromToolCall('bash', JSON.stringify({ command: 'ls' })), '执行命令：ls')
  assert.equal(
    currentTaskFromToolCall('read_file', JSON.stringify({ file_path: 'a.ts' })),
    '查看文件：a.ts',
  )
  assert.equal(
    currentTaskFromToolCall('str_replace_editor', JSON.stringify({ path: 'a.ts' })),
    '修改文件：a.ts',
  )
})

test('currentTaskFromToolCall：未知工具退化为工具名本身', () => {
  assert.equal(currentTaskFromToolCall('SomeFutureTool', '{}'), '正在使用 SomeFutureTool')
})

test('currentTaskFromToolCall：参数解析失败或缺失时仍给出可读标签', () => {
  // 原始 arguments 是模型产出且未解析的 JSON 字符串，畸形是常态而非异常。
  for (const bad of ['', '{', 'not json', 'null', '[]', '"str"', '{"command":42}']) {
    assert.doesNotThrow(() => currentTaskFromToolCall('Bash', bad))
    assert.equal(currentTaskFromToolCall('Bash', bad), '执行命令')
  }
  assert.equal(currentTaskFromToolCall('Bash', undefined), '执行命令')
  assert.equal(currentTaskFromToolCall('', '{}'), null)
})

test('currentTaskFromToolCall：多行命令只取首行', () => {
  assert.equal(
    currentTaskFromToolCall('Bash', JSON.stringify({ command: 'cd /tmp\necho hello' })),
    '执行命令：cd /tmp',
  )
})

test('truncateTask 不切断代理对（emoji 不得被切成半个）', () => {
  const label = '🐳'.repeat(100)
  const out = truncateTask(label, 10)
  assert.equal([...out].length, 10)
  // 若按 UTF-16 单元切，会出现落单代理；遍历一次就暴露。
  assert.doesNotThrow(() => encodeURIComponent(out))
  assert.ok(!/\uFFFD/.test(out))
})

test('truncateTask 短文本原样返回，长文本带省略号', () => {
  assert.equal(truncateTask('短', 10), '短')
  assert.equal(truncateTask('12345', 5), '12345')
  assert.equal(truncateTask('123456', 5), `${'1234'}…`)
})
