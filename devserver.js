#!/usr/bin/env node
/* devserver.js — локальный приёмник логов расширения + очередь тестовых команд */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8788;
const LOG_FILE = path.join(__dirname, 'dev.log');
const CMD_FILE = path.join(__dirname, 'devcommands.json');

fs.appendFileSync(LOG_FILE, `\n===== devserver start ${new Date().toISOString()} =====\n`);

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type'
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  if (req.method === 'POST' && url.pathname === '/log') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { line } = JSON.parse(body);
        const entry = `[${new Date().toISOString()}] ${line}\n`;
        fs.appendFileSync(LOG_FILE, entry);
        process.stdout.write(entry);
      } catch (e) { /* ignore */ }
      res.writeHead(200, CORS); res.end('ok');
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/config') {
    /* отдаём по одной команде из очереди */
    let cmds = [];
    try { cmds = JSON.parse(fs.readFileSync(CMD_FILE, 'utf8')); } catch (e) {}
    const cmd = cmds.shift() || { action: 'noop' };
    fs.writeFileSync(CMD_FILE, JSON.stringify(cmds));
    res.writeHead(200, Object.assign({ 'content-type': 'application/json' }, CORS));
    return res.end(JSON.stringify(cmd));
  }

  res.writeHead(404, CORS); res.end('not found');
}).listen(PORT, '127.0.0.1', () => {
  console.log(`dev server on http://localhost:${PORT}  (log: ${LOG_FILE})`);
  console.log('очередь команд: devcommands.json (массив объектов {action:...})');
});
