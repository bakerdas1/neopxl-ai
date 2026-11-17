import { spawn } from 'child_process';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const acorn = require('acorn');

// ---------------------------------------------------------------------------
// Configuration (security limits)
// ---------------------------------------------------------------------------

const CONFIG = {
  maxCodeSize: 50 * 1024,           // 50 KB max source size
  maxInputSize: 5 * 1024 * 1024,    // 5 MB max input JSON
  maxOutputSize: 1 * 1024 * 1024,   // 1 MB max output JSON
  maxStdoutSize: 64 * 1024,         // 64 KB captured stdout/stderr
  timeoutMs: 5000,                  // 5 s wall-clock
  maxMemoryMb: 128,                 // 128 MB
};

// ---------------------------------------------------------------------------
// Python allowlists / blocklists
// ---------------------------------------------------------------------------

const PYTHON_ALLOWED_MODULES = new Set([
  'json', 'math', 'decimal', 'fractions', 'statistics', 'datetime', 're',
  'itertools', 'functools', 'collections', 'operator', 'typing', 'dataclasses',
  'string',
]);

const PYTHON_BLOCKED_MODULES = new Set([
  'os', 'sys', 'subprocess', 'socket', 'ssl', 'requests', 'urllib', 'http',
  'ftplib', 'smtplib', 'shutil', 'pathlib', 'glob', 'tempfile', 'ctypes',
  'cffi', 'importlib', 'runpy', 'pickle', 'marshal', 'shelve',
  'multiprocessing', 'threading', 'asyncio', 'signal', 'resource', 'gc',
  'inspect', 'builtins', 'code', 'codeop', 'pty', 'platform', 'sqlite3',
]);

const PYTHON_BLOCKED_BUILTINS = new Set([
  'open', 'exec', 'eval', 'compile', '__import__', 'input', 'breakpoint',
  'globals', 'locals', 'vars',
]);

const PYTHON_DUNDER_ATTRS = new Set([
  '__class__', '__bases__', '__subclasses__', '__globals__', '__builtins__',
  '__code__', '__dict__', '__mro__', '__import__', '__loader__', '__spec__',
]);

// ---------------------------------------------------------------------------
// JavaScript allowlists / blocklists
// ---------------------------------------------------------------------------

const JS_BLOCKED_MODULES = new Set([
  'fs', 'child_process', 'net', 'http', 'https', 'http2', 'dgram', 'dns',
  'tls', 'cluster', 'worker_threads', 'vm', 'os', 'path', 'process', 'module',
  'v8', 'repl', 'readline', 'crypto',
]);

const JS_BLOCKED_GLOBALS = new Set([
  'process', 'require', 'module', '__dirname', '__filename', 'global',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts',
]);

const JS_BLOCKED_PATTERNS = [
  'constructor.constructor',
  '__proto__',
  'setPrototypeOf',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'Function(',
  'AsyncFunction',
  'GeneratorFunction',
  'eval(',
  'importScripts',
];

// ---------------------------------------------------------------------------
// Helper: hash input for audit logging (no full data)
// ---------------------------------------------------------------------------

function hashInput(data) {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Python save-time validation
// ---------------------------------------------------------------------------

/**
 * Validate Python source code at save time.
 * Returns { ok: true } or { ok: false, reason: string }.
 * Uses a subprocess to parse with Python's ast module.
 */
async function validatePythonCode(code) {
  if (code.length > CONFIG.maxCodeSize) {
    return { ok: false, reason: `Code exceeds ${Math.floor(CONFIG.maxCodeSize / 1024)} KB size limit` };
  }

  // Must define a top-level `run` function
  if (!/^\s*def\s+run\s*\(/m.test(code)) {
    return { ok: false, reason: 'Python script must define a top-level run(data) function' };
  }

  // Spawn python3 to parse and walk the AST
  const validatorScript = [
    'import ast, json, sys',
    'code = sys.stdin.read()',
    'blocked_modules = ' + JSON.stringify([...PYTHON_BLOCKED_MODULES]),
    'blocked_builtins = ' + JSON.stringify([...PYTHON_BLOCKED_BUILTINS]),
    'dunder_attrs = ' + JSON.stringify([...PYTHON_DUNDER_ATTRS]),
    '',
    'class Walker(ast.NodeVisitor):',
    '    def __init__(self):',
    '        self.blocked = []',
    '',
    '    def visit_Import(self, node):',
    '        for alias in node.names:',
    '            mod = alias.name.split(\'.\')[0]',
    '            if mod in blocked_modules:',
    '                self.blocked.append(f\'Blocked import: {alias.name} (line {node.lineno})\')',
    '        self.generic_visit(node)',
    '',
    '    def visit_ImportFrom(self, node):',
    '        if node.module:',
    '            mod = node.module.split(\'.\')[0]',
    '            if mod in blocked_modules:',
    '                self.blocked.append(f\'Blocked from-import: {node.module} (line {node.lineno})\')',
    '        self.generic_visit(node)',
    '',
    '    def visit_Call(self, node):',
    '        if isinstance(node.func, ast.Name):',
    '            if node.func.id in blocked_builtins:',
    '                self.blocked.append(f\'Blocked builtin call: {node.func.id} (line {node.lineno})\')',
    '        if isinstance(node.func, ast.Name) and node.func.id in (\'getattr\', \'setattr\', \'delattr\'):',
    '            for arg in node.args:',
    '                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):',
    '                    if arg.value in dunder_attrs:',
    '                        self.blocked.append(f\'Blocked dunder access via {node.func.id}: {arg.value} (line {node.lineno})\')',
    '        self.generic_visit(node)',
    '',
    '    def visit_Attribute(self, node):',
    '        if isinstance(node.attr, str) and node.attr in dunder_attrs:',
    '            self.blocked.append(f\'Blocked dunder attribute: .{node.attr} (line {node.lineno})\')',
    '        self.generic_visit(node)',
    '',
    'try:',
    '    tree = ast.parse(code)',
    'except SyntaxError as e:',
    '    print(json.dumps({\'ok\': False, \'reason\': f\'Syntax error: {e.msg} (line {e.lineno})\'}))',
    '    sys.exit(0)',
    '',
    'walker = Walker()',
    'walker.visit(tree)',
    '',
    'has_run = any(',
    '    isinstance(n, ast.FunctionDef) and n.name == \'run\'',
    '    for n in ast.walk(tree)',
    ')',
    'if not has_run:',
    '    print(json.dumps({\'ok\': False, \'reason\': \'Missing required top-level run(data) function\'}))',
    '    sys.exit(0)',
    '',
    'if walker.blocked:',
    '    print(json.dumps({\'ok\': False, \'reason\': walker.blocked[0]}))',
    '    sys.exit(0)',
    '',
    'print(json.dumps({\'ok\': True}))',
  ].join('\n');

  try {
    const tmpDir = await mkdtemp(join(tmpdir(), 'documind-wf-val-'));
    const validatorPath = join(tmpDir, 'validate.py');
    await writeFile(validatorPath, validatorScript);

    const proc = spawn('python3', [validatorPath], {
      cwd: tmpDir,
      env: { PATH: '/usr/bin:/bin' },
      timeout: CONFIG.timeoutMs,
      maxBuffer: CONFIG.maxStdoutSize,
    });

    let stdout = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stdin.write(code);
    proc.stdin.end();

    const result = await new Promise((resolve, reject) => {
      proc.on('close', code => {
        if (code !== 0 && !stdout) {
          reject(new Error(`Validator exited with code ${code}`));
        } else {
          resolve(stdout);
        }
      });
      proc.on('error', reject);
    });

    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});

    const parsed = JSON.parse(result.trim());
    return parsed;
  } catch (err) {
    return { ok: false, reason: `Validation error: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// JavaScript save-time validation
// ---------------------------------------------------------------------------

/**
 * Validate JavaScript source code at save time.
 * Returns { ok: true } or { ok: false, reason: string }.
 */
function validateJavaScriptCode(code) {
  if (code.length > CONFIG.maxCodeSize) {
    return { ok: false, reason: `Code exceeds ${Math.floor(CONFIG.maxCodeSize / 1024)} KB size limit` };
  }

  // Must define a top-level `run` function
  if (!/function\s+run\s*\(/m.test(code)) {
    return { ok: false, reason: 'JavaScript script must define a top-level `function run(data)`' };
  }

  try {
    const ast = acorn.parse(code, {
      ecmaVersion: 2022,
      sourceType: 'module',
    });

    // Walk the AST looking for blocked patterns
    const blocked = [];

    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }

      // Check for blocked global identifiers
      if (node.type === 'Identifier') {
        if (JS_BLOCKED_GLOBALS.has(node.name)) {
          blocked.push(`Blocked global: ${node.name} (line ${node.loc?.start.line})`);
        }
      }

      // Check for blocked member chains: obj.process, obj.require, etc.
      if (node.type === 'MemberExpression') {
        const obj = node.object;
        const prop = node.property;
        if (obj && obj.type === 'Identifier' && prop && prop.type === 'Identifier') {
          const chain = obj.name + '.' + prop.name;
          if (chain === 'process.exit' || chain === 'process.env' || chain === 'module.exports' ||
              chain === '__proto__' || chain === 'Object.setPrototypeOf') {
            blocked.push(`Blocked member chain: ${chain} (line ${node.loc?.start.line})`);
          }
        }
      }

      // Check for CallExpression with blocked callee
      if (node.type === 'CallExpression') {
        const callee = node.callee;
        if (callee && callee.type === 'Identifier') {
          if (callee.name === 'eval' || callee.name === 'require') {
            blocked.push(`Blocked call: ${callee.name}() (line ${node.loc?.start.line})`);
          }
        }
        if (callee && callee.type === 'MemberExpression') {
          const obj = callee.object;
          const prop = callee.property;
          if (obj && obj.type === 'Identifier' && prop && prop.type === 'Identifier') {
            const chain = obj.name + '.' + prop.name;
            if (chain === 'constructor.constructor') {
              blocked.push(`Blocked constructor.constructor chain (line ${node.loc?.start.line})`);
            }
          }
        }
      }

      // Check for import statements (blocked, only allowlist modules via loader)
      if (node.type === 'ImportDeclaration') {
        const source = node.source?.value;
        if (source && !['lodash', 'dayjs', 'date-fns', 'jsonpath-plus', 'decimal.js', 'big.js'].includes(source)) {
          blocked.push(`Blocked import: ${source} (line ${node.loc?.start.line})`);
        }
      }

      // Check for dynamic import()
      if (node.type === 'CallExpression' && node.callee && node.callee.type === 'Import') {
        blocked.push('Blocked dynamic import() (line ' + (node.loc?.start.line) + ')');
      }

      // Recurse into all properties
      for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'start' || key === 'end' || key === 'range') continue;
        walk(node[key]);
      }
    }

    walk(ast);

    if (blocked.length > 0) {
      return { ok: false, reason: blocked[0] };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `Syntax error: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Python runtime sandbox
// ---------------------------------------------------------------------------

const PYTHON_WRAPPER = [
  'import json, sys, ast, importlib.util',
  '',
  'CODE_PATH = sys.argv[1]',
  '',
  'blocked_modules = ' + JSON.stringify([...PYTHON_BLOCKED_MODULES]) + '',
  'blocked_builtins = ' + JSON.stringify([...PYTHON_BLOCKED_BUILTINS]) + '',
  'dunder_attrs = ' + JSON.stringify([...PYTHON_DUNDER_ATTRS]) + '',
  '',
  'class Walker(ast.NodeVisitor):',
  '    def __init__(self):',
  '        self.blocked = []',
  '',
  '    def visit_Import(self, node):',
  '        for alias in node.names:',
  '            mod = alias.name.split(\'.\')[0]',
  '            if mod in blocked_modules:',
  '                self.blocked.append(\'Blocked import: \' + alias.name)',
  '        self.generic_visit(node)',
  '',
  '    def visit_ImportFrom(self, node):',
  '        if node.module:',
  '            mod = node.module.split(\'.\')[0]',
  '            if mod in blocked_modules:',
  '                self.blocked.append(\'Blocked from-import: \' + node.module)',
  '        self.generic_visit(node)',
  '',
  '    def visit_Call(self, node):',
  '        if isinstance(node.func, ast.Name) and node.func.id in blocked_builtins:',
  '            self.blocked.append(\'Blocked builtin call: \' + node.func.id)',
  '        if isinstance(node.func, ast.Name) and node.func.id in (\'getattr\', \'setattr\', \'delattr\'):',
  '            for arg in node.args:',
  '                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):',
  '                    if arg.value in dunder_attrs:',
  '                        self.blocked.append(\'Blocked dunder access via \' + node.func.id + \': \' + arg.value)',
  '        self.generic_visit(node)',
  '',
  '    def visit_Attribute(self, node):',
  '        if isinstance(node.attr, str) and node.attr in dunder_attrs:',
  '            self.blocked.append(\'Blocked dunder attribute: .\' + node.attr)',
  '        self.generic_visit(node)',
  '',
  'def fail(etype, message):',
  '    print(json.dumps({\'error\': {\'type\': etype, \'message\': message}}), file=sys.stderr)',
  '    sys.exit(1)',
  '',
  '# Read and validate user code',
  'with open(CODE_PATH) as f:',
  '    code = f.read()',
  '',
  'try:',
  '    tree = ast.parse(code)',
  'except SyntaxError as e:',
  '    fail(\'syntax\', str(e))',
  '',
  'walker = Walker()',
  'walker.visit(tree)',
  '',
  'has_run = any(isinstance(n, ast.FunctionDef) and n.name == \'run\' for n in ast.walk(tree))',
  'if not has_run:',
  '    fail(\'missing_run\', \'Missing run function\')',
  '',
  'if walker.blocked:',
  '    fail(\'blocked\', walker.blocked[0])',
  '',
  '# Load and execute user code with restricted builtins',
  'spec = importlib.util.spec_from_file_location(\"user_workflow\", CODE_PATH)',
  'module = importlib.util.module_from_spec(spec)',
  '',
  'safe_builtins = {',
  '    \'len\': len, \'range\': range, \'sum\': sum, \'min\': min, \'max\': max,',
  '    \'sorted\': sorted, \'enumerate\': enumerate, \'zip\': zip, \'map\': map,',
  '    \'filter\': filter, \'abs\': abs, \'round\': round, \'int\': int, \'float\': float,',
  '    \'str\': str, \'bool\': bool, \'list\': list, \'dict\': dict, \'set\': set,',
  '    \'tuple\': tuple, \'isinstance\': isinstance,',
  '}',
  'module.__builtins__ = safe_builtins',
  'spec.loader.exec_module(module)',
  '',
  '# Read input from stdin',
  'raw = sys.stdin.read()',
  'data = json.loads(raw)',
  '',
  '# Run',
  'result = module.run(data)',
  '',
  '# Serialize output',
  'print(json.dumps(result))',
].join('\n');

async function runPythonCode(code, inputData) {
  const inputJson = JSON.stringify(inputData);
  if (inputJson.length > CONFIG.maxInputSize) {
    return { ok: false, error: { type: 'input_size', message: 'Input exceeds 5 MB limit' } };
  }

  const tmpDir = await mkdtemp(join(tmpdir(), 'documind-wf-py-'));
  try {
    const codePath = join(tmpDir, 'workflow.py');
    const wrapperPath = join(tmpDir, 'runner.py');

    await writeFile(codePath, code);
    await writeFile(wrapperPath, PYTHON_WRAPPER);

    const proc = spawn('python3', [wrapperPath, codePath], {
      cwd: tmpDir,
      env: { PATH: '/usr/bin:/bin' },
      timeout: CONFIG.timeoutMs,
      maxBuffer: CONFIG.maxStdoutSize,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.stdin.write(inputJson);
    proc.stdin.end();

    const exitCode = await new Promise(resolve => {
      proc.on('close', resolve);
    });

    if (exitCode !== 0 && !stdout) {
      return {
        ok: false,
        error: { type: 'runtime', message: stderr || `Process exited with code ${exitCode}` },
      };
    }

    // Parse output
    let result;
    try {
      result = JSON.parse(stdout.trim());
    } catch {
      return {
        ok: false,
        error: { type: 'output_parse', message: 'Failed to parse workflow output as JSON' },
      };
    }

    const outputJson = JSON.stringify(result);
    if (outputJson.length > CONFIG.maxOutputSize) {
      return { ok: false, error: { type: 'output_size', message: 'Output exceeds 1 MB limit' } };
    }

    return { ok: true, result, stderr };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// JavaScript runtime sandbox
// ---------------------------------------------------------------------------

const JS_WRAPPER = `
const fs = require('fs');
const { parse } = require('acorn');

const CODE_PATH = process.argv[2];

const code = fs.readFileSync(CODE_PATH, 'utf8');

// Parse and validate
let ast;
try {
  ast = parse(code, { ecmaVersion: 2022, sourceType: 'module' });
} catch (e) {
  console.error(JSON.stringify({ error: { type: 'syntax', message: e.message } }));
  process.exit(1);
}

// Blocked checks
const blockedGlobals = ${JSON.stringify([...JS_BLOCKED_GLOBALS])};
const blockedModules = ${JSON.stringify([...JS_BLOCKED_MODULES])};
const blockedPatterns = ${JSON.stringify(JS_BLOCKED_PATTERNS)};

function walk(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(walk); return; }

  if (node.type === 'Identifier' && blockedGlobals.includes(node.name)) {
    console.error(JSON.stringify({ error: { type: 'blocked_global', message: 'Blocked global: ' + node.name, line: node.loc?.start.line } }));
    process.exit(1);
  }

  if (node.type === 'MemberExpression') {
    const obj = node.object;
    const prop = node.property;
    if (obj && obj.type === 'Identifier' && prop && prop.type === 'Identifier') {
      const chain = obj.name + '.' + prop.name;
      if (chain === 'process.exit' || chain === 'process.env' || chain === 'module.exports') {
        console.error(JSON.stringify({ error: { type: 'blocked_member', message: 'Blocked member: ' + chain, line: node.loc?.start.line } }));
        process.exit(1);
      }
    }
  }

  if (node.type === 'CallExpression') {
    const callee = node.callee;
    if (callee && callee.type === 'Identifier') {
      if (callee.name === 'eval' || callee.name === 'require') {
        console.error(JSON.stringify({ error: { type: 'blocked_call', message: 'Blocked call: ' + callee.name + '()', line: node.loc?.start.line } }));
        process.exit(1);
      }
    }
    if (callee && callee.type === 'MemberExpression') {
      const obj = callee.object;
      const prop = callee.property;
      if (obj && obj.type === 'Identifier' && prop && prop.type === 'Identifier') {
        if (obj.name === 'constructor' && prop.name === 'constructor') {
          console.error(JSON.stringify({ error: { type: 'blocked_chain', message: 'Blocked constructor.constructor chain', line: node.loc?.start.line } }));
          process.exit(1);
        }
      }
    }
  }

  if (node.type === 'ImportDeclaration') {
    const source = node.source?.value;
    const allowed = ['lodash', 'dayjs', 'date-fns', 'jsonpath-plus', 'decimal.js', 'big.js'];
    if (source && !allowed.includes(source)) {
      console.error(JSON.stringify({ error: { type: 'blocked_import', message: 'Blocked import: ' + source, line: node.loc?.start.line } }));
      process.exit(1);
    }
  }

  if (node.type === 'CallExpression' && node.callee && node.callee.type === 'Import') {
    console.error(JSON.stringify({ error: { type: 'blocked_dynamic_import', message: 'Blocked dynamic import()', line: node.loc?.start.line } }));
    process.exit(1);
  }

  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'range') continue;
    walk(node[key]);
  }
}

walk(ast);

// Check for run function
const hasRun = ast.body.some(n => n.type === 'FunctionDeclaration' && n.id && n.id.name === 'run');
if (!hasRun) {
  console.error(JSON.stringify({ error: { type: 'missing_run', message: 'Missing required function run(data)' } }));
  process.exit(1);
}

// Create isolated context and execute
const vm = require('vm');
const sandbox = {};
vm.runInNewContext(code, sandbox, { filename: CODE_PATH });

// Read input from stdin
let inputData = '';
process.stdin.on('data', chunk => { inputData += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(inputData);
    const result = sandbox.run(data);
    const output = JSON.stringify(result);
    process.stdout.write(output);
  } catch (e) {
    console.error(JSON.stringify({ error: { type: 'runtime', message: e.message, line: e.lineNumber } }));
    process.exit(1);
  }
});
`;

async function runJavaScriptCode(code, inputData) {
  const inputJson = JSON.stringify(inputData);
  if (inputJson.length > CONFIG.maxInputSize) {
    return { ok: false, error: { type: 'input_size', message: 'Input exceeds 5 MB limit' } };
  }

  const tmpDir = await mkdtemp(join(tmpdir(), 'documind-wf-js-'));
  try {
    const codePath = join(tmpDir, 'workflow.js');
    const wrapperPath = join(tmpDir, 'runner.js');

    await writeFile(codePath, code);
    await writeFile(wrapperPath, JS_WRAPPER);

    const proc = spawn('node', [wrapperPath, codePath], {
      cwd: tmpDir,
      env: { PATH: '/usr/bin:/bin' },
      timeout: CONFIG.timeoutMs,
      maxBuffer: CONFIG.maxStdoutSize,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.stdin.write(inputJson);
    proc.stdin.end();

    const exitCode = await new Promise(resolve => {
      proc.on('close', resolve);
    });

    if (exitCode !== 0 && !stdout) {
      // Try to parse stderr as structured error
      try {
        const parsed = JSON.parse(stderr.trim());
        return { ok: false, error: parsed.error || { type: 'runtime', message: stderr } };
      } catch {
        return {
          ok: false,
          error: { type: 'runtime', message: stderr || `Process exited with code ${exitCode}` },
        };
      }
    }

    // Parse output
    let result;
    try {
      result = JSON.parse(stdout.trim());
    } catch {
      return {
        ok: false,
        error: { type: 'output_parse', message: 'Failed to parse workflow output as JSON' },
      };
    }

    const outputJson = JSON.stringify(result);
    if (outputJson.length > CONFIG.maxOutputSize) {
      return { ok: false, error: { type: 'output_size', message: 'Output exceeds 1 MB limit' } };
    }

    return { ok: true, result, stderr };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate workflow code at save time.
 * language: 'python' | 'javascript'
 */
export async function validateWorkflowCode(language, code) {
  if (language === 'python') {
    return await validatePythonCode(code);
  }
  if (language === 'javascript') {
    return validateJavaScriptCode(code);
  }
  return { ok: false, reason: `Unknown language: ${language}` };
}

/**
 * Execute a workflow script in a sandboxed subprocess.
 * Returns { ok: true, result } or { ok: false, error: { type, message, line? } }.
 */
export async function runWorkflow(language, code, inputData) {
  if (language === 'python') {
    return await runPythonCode(code, inputData);
  }
  if (language === 'javascript') {
    return await runJavaScriptCode(code, inputData);
  }
  return { ok: false, error: { type: 'config', message: `Unknown language: ${language}` } };
}

export { CONFIG, hashInput };