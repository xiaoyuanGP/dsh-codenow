#!/usr/bin/env node
// codenow blender bridge —— 最小 MCP stdio 服务器。
//
// 它只做一件事：把 MCP 的 JSON-RPC（stdin/stdout，换行分隔）转发成 Blender
// addon 的 TCP JSON 行协议（127.0.0.1:9876，请求 {id,type:"command",category,action,params}）。
// 这样用户装了插件就有建模能力，不需要再装 Python 版的 blender-mcp。
//
// 上游（MIT）只提供了命令约定，代码为独立实现，详见插件根目录 NOTICES.md。

import net from 'node:net';

const HOST = process.env.CODENOW_BLENDER_HOST || '127.0.0.1';
const PORT = Number(process.env.CODENOW_BLENDER_PORT || 9876);
const TIMEOUT_MS = Number(process.env.CODENOW_BLENDER_TIMEOUT_MS || 120000);
const SERVER_NAME = 'codenow-blender';
const SERVER_VERSION = '1.0.0';

// 工具名 → addon 命令。映射取自上游各工具的真实调用点；未核实的工具不暴露。
const TOOLS = [
  ['blender_get_info', 'system', 'get_info', 'Blender 版本、场景与对象概览'],
  ['blender_scene_list', 'scene', 'list', '列出所有场景'],
  ['blender_scene_get_info', 'scene', 'get_info', '取单个场景的信息'],
  ['blender_scene_create', 'scene', 'create', '新建场景'],
  ['blender_scene_switch', 'scene', 'switch', '切换当前场景'],
  ['blender_scene_delete', 'scene', 'delete', '删除场景'],
  ['blender_object_create', 'object', 'create', '创建物体（立方体/球/圆柱/猴头等）'],
  ['blender_object_delete', 'object', 'delete', '删除物体'],
  ['blender_object_duplicate', 'object', 'duplicate', '复制物体'],
  ['blender_object_transform', 'object', 'transform', '设置位置/旋转/缩放'],
  ['blender_object_select', 'object', 'select', '选中/取消选中物体'],
  ['blender_object_list', 'object', 'list', '列出物体'],
  ['blender_object_get_info', 'object', 'get_info', '取物体详情'],
  ['blender_object_rename', 'object', 'rename', '重命名物体'],
  ['blender_object_parent', 'object', 'parent', '设置父子关系'],
  ['blender_object_join', 'object', 'join', '合并物体'],
  ['blender_execute_python', 'utility', 'execute_python', '在 Blender 主线程执行 bpy 代码（万能兜底）'],
  ['blender_export_gltf', 'export', 'gltf', '导出 glTF/GLB'],
  ['blender_export_fbx', 'export', 'fbx', '导出 FBX'],
  ['blender_export_obj', 'export', 'obj', '导出 OBJ'],
  ['blender_file_save', 'file', 'save', '保存 .blend'],
  ['blender_file_open', 'file', 'open', '打开 .blend'],
];

const LOCALS = new Set(['blender_connection_status']);

const schemaFor = (name) => ({
  type: 'object',
  properties: {
    params: {
      type: 'object',
      additionalProperties: true,
      description: `${name} 的入参；也可以省略这一层，直接把参数放在顶层。`,
    },
  },
  additionalProperties: true,
});

// ---- Blender addon 连接 ----
let socket = null;
let buffer = '';
let seq = 0;
const waiters = new Map();

function rejectAll(reason) {
  for (const [, w] of waiters) {
    clearTimeout(w.timer);
    w.reject(new Error(reason));
  }
  waiters.clear();
}

function ensureSocket() {
  if (socket && !socket.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: HOST, port: PORT });
    s.setEncoding('utf8');
    const onError = (err) => {
      s.destroy();
      socket = null;
      reject(
        new Error(
          `连不上 Blender（${HOST}:${PORT}）：${err.code || err.message}。` +
            `请先打开 Blender，并在侧栏 addon 面板点 Start 启动服务。`,
        ),
      );
    };
    s.once('error', onError);
    s.once('connect', () => {
      s.off('error', onError);
      s.on('error', (err) => {
        rejectAll(`Blender 连接出错：${err.code || err.message}`);
        socket = null;
      });
      s.on('close', () => {
        rejectAll('Blender 侧关闭了连接（addon 服务停了或 Blender 退出了）。');
        socket = null;
      });
      s.on('data', (chunk) => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i).trim();
          buffer = buffer.slice(i + 1);
          if (!line) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          const key = msg?.id === undefined ? null : String(msg.id);
          const w = key ? waiters.get(key) : null;
          if (w) {
            waiters.delete(key);
            clearTimeout(w.timer);
            w.resolve(msg);
          }
        }
      });
      socket = s;
      buffer = '';
      resolve();
    });
  });
}

async function command(category, action, params) {
  await ensureSocket();
  const id = String(++seq);
  const payload = { id, type: 'command', category, action, params: params ?? {} };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`Blender 在 ${TIMEOUT_MS}ms 内没有回应（category=${category} action=${action}）。`));
    }, TIMEOUT_MS);
    waiters.set(id, { resolve, reject, timer });
    socket.write(JSON.stringify(payload) + '\n', (err) => {
      if (err) {
        clearTimeout(timer);
        waiters.delete(id);
        reject(err);
      }
    });
  });
}

// ---- MCP 层 ----
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function textResult(id, obj, isError = false) {
  return rpcResult(id, {
    content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }],
    isError,
  });
}

function normalizeArgs(args) {
  if (args && typeof args === 'object') {
    if (args.params && typeof args.params === 'object') return args.params;
    const { params, ...rest } = args;
    void params;
    return rest;
  }
  return {};
}

async function callTool(id, name, args) {
  if (name === 'blender_connection_status') {
    try {
      await ensureSocket();
      return textResult(id, { connected: true, address: `${HOST}:${PORT}`, pending: waiters.size });
    } catch (err) {
      return textResult(id, { connected: false, address: `${HOST}:${PORT}`, error: err.message }, true);
    }
  }
  const row = TOOLS.find((t) => t[0] === name);
  if (!row) return rpcError(id, RPC_INVALID_PARAMS, `未知工具：${name}`);
  const [, category, action] = row;
  try {
    const resp = await command(category, action, normalizeArgs(args));
    const failed = resp?.status === 'error' || resp?.error || resp?.success === false;
    return textResult(id, resp, Boolean(failed));
  } catch (err) {
    return textResult(id, { ok: false, error: err.message }, true);
  }
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  if (isNotification) return null;

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') {
    const tools = TOOLS.map(([name, category, action, description]) => ({
      name,
      description,
      inputSchema: schemaFor(name),
    }));
    tools.unshift({
      name: 'blender_connection_status',
      description: '查询与 Blender 的连接状态（不只是配置，而是真的去连一次）',
      inputSchema: schemaFor('blender_connection_status'),
    });
    void LOCALS;
    return rpcResult(id, { tools });
  }
  if (method === 'tools/call') {
    const name = params?.name;
    if (!name) return rpcError(id, RPC_INVALID_PARAMS, 'tools/call 缺少 name');
    return callTool(id, name, params?.arguments);
  }
  return rpcError(id, RPC_METHOD_NOT_FOUND, `不支持的方法：${method}`);
}

let stdinBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuf += chunk;
  let i;
  while ((i = stdinBuf.indexOf('\n')) >= 0) {
    const line = stdinBuf.slice(0, i).trim();
    stdinBuf = stdinBuf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handleRequest(msg)
      .then((out) => {
        if (out) process.stdout.write(JSON.stringify(out) + '\n');
      })
      .catch((err) => {
        if (msg?.id !== undefined && msg?.id !== null) {
          process.stdout.write(JSON.stringify(rpcError(msg.id, -32603, err.message)) + '\n');
        }
      });
  }
});
process.stdin.on('end', () => {
  if (socket) socket.destroy();
  process.exit(0);
});
