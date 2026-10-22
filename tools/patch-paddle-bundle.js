#!/usr/bin/env node
/* patch-paddle-bundle.js — hält das Paddle-Bundle CSP-fähig.
   Chrome-MV3-Erweiterungsseiten erlauben kein `unsafe-eval`. Emscripten
   erzeugt dynamische Aufrufer (dynCall, Embind-Method-Caller) über den
   Function-Konstruktor; die folgenden Ersetzungen bauen dieselben Aufrufer
   als gewöhnliche JavaScript-Closures. Zusätzlich wird die WebGPU-Probe
   deaktiviert, wenn der Host ausdrücklich den WASM-Backend wählt.
   Das Skript bricht ab, wenn danach noch ein Function-Konstruktor im Bundle
   steht oder das Paddle-WebGPU-Muster fehlt. */
'use strict';
const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('Verwendung: node tools/patch-paddle-bundle.js <paddle.bundle.js>');
  process.exit(2);
}

let source = fs.readFileSync(file, 'utf8');

const namedOld = 'return new Function("body", "return function " + name + \'() {\\n    "use strict";    return body.apply(this, arguments);\\n};\\n\')(body);';
const namedNew = `var fn = function () {
                "use strict";
                return body.apply(this, arguments);
              };
              try { Object.defineProperty(fn, "name", { value: name, configurable: true }); } catch (e) { /* Name ist kosmetisch */ }
              return fn;`;
if (source.includes(namedOld)) source = source.replace(namedOld, namedNew);

const dynOld = 'return new Function("dynCall", "rawFunction", body)(dynCall2, rawFunction);';
const dynNew = 'return dynCall2.bind(null, rawFunction);';
if (source.includes(dynOld)) source = source.replace(dynOld, dynNew);

/* craftInvokerFunction baut den Embind-Aufrufer normalerweise per
   new Function(args1)(args2). Die Ersatzfunktion macht dieselben
   toWireType/fromWireType-/Destruktor-Schritte direkt in JavaScript. */
const invokerOld = `              var invokerFunction = new_(Function, args1).apply(null, args2);
              return invokerFunction;`;
const invokerNew = `              var invokerFunction = function () {
                if (arguments.length !== argCount - 2) {
                  throwBindingError("function " + humanName + " called with " + arguments.length + " arguments, expected " + (argCount - 2) + " args!");
                }
                var destructors = needsDestructorStack ? [] : null;
                var thisWired;
                var wired = [];
                if (isClassMethodFunc) {
                  thisWired = argTypes[1].toWireType(destructors, this);
                }
                for (var i = 0; i < argCount - 2; ++i) {
                  wired.push(argTypes[i + 2].toWireType(destructors, arguments[i]));
                }
                var callArgs = isClassMethodFunc ? [thisWired].concat(wired) : wired;
                var rv = cppInvokerFunc.apply(null, [cppTargetFunc].concat(callArgs));
                if (needsDestructorStack) {
                  runDestructors(destructors);
                } else {
                  for (var i = isClassMethodFunc ? 1 : 2; i < argTypes.length; ++i) {
                    var param = i === 1 ? thisWired : wired[i - 2];
                    if (argTypes[i].destructorFunction !== null) {
                      argTypes[i].destructorFunction(param);
                    }
                  }
                }
                return returns ? argTypes[0].fromWireType(rv) : void 0;
              };
              return invokerFunction;`;
if (source.includes(invokerOld)) source = source.replace(invokerOld, invokerNew);

/* __emval_get_method_caller baut ebenfalls einen Aufrufer per Function-
   Konstruktor. Die Ersatzfunktion liest die Argumente direkt über die
   Embind-Typen und ruft die Methode mit apply auf. */
const emvalOld = `              var invokerFunction = new_(Function, params).apply(null, args);
              return __emval_addMethodCaller(invokerFunction);`;
const emvalNew = `              var invokerFunction = function (handle, name, destructors, args) {
                var offset = 0;
                var callArgs = [];
                for (var i = 0; i < argCount - 1; ++i) {
                  callArgs.push(types2[i + 1].readValueFromPointer(args + offset));
                  offset += types2[i + 1].argPackAdvance;
                }
                var rv = handle[name].apply(handle, callArgs);
                for (var i = 0; i < argCount - 1; ++i) {
                  if (types2[i + 1].deleteObject) {
                    types2[i + 1].deleteObject(callArgs[i]);
                  }
                }
                if (!retType.isVoid) {
                  return retType.toWireType(destructors, rv);
                }
              };
              return __emval_addMethodCaller(invokerFunction);`;
if (source.includes(emvalOld)) source = source.replace(emvalOld, emvalNew);

/* fast-opencv-wasm wird minifiziert ausgeliefert. Hier heißen dieselben
   Aufrufer `newFunc(Function, …)`. */
const minInvokerOld = 'var invokerFn = newFunc(Function, args)(...closureArgs);';
const minInvokerNew = `var invokerFn = function () {
                  if (arguments.length !== argCount - 2) {
                    throwBindingError("function " + humanName + " called with " + arguments.length + " arguments, expected " + (argCount - 2) + " args!");
                  }
                  var destructors = needsDestructorStack ? [] : null;
                  var thisWired;
                  var wired = [];
                  if (isClassMethodFunc) {
                    thisWired = argTypes[1].toWireType(destructors, this);
                  }
                  for (var i = 0; i < argCount - 2; ++i) {
                    wired.push(argTypes[i + 2].toWireType(destructors, arguments[i]));
                  }
                  var callArgs = isClassMethodFunc ? [thisWired].concat(wired) : wired;
                  var rv = cppInvokerFunc.apply(null, [cppTargetFunc].concat(callArgs));
                  if (needsDestructorStack) {
                    runDestructors(destructors);
                  } else {
                    for (var i = isClassMethodFunc ? 1 : 2; i < argTypes.length; ++i) {
                      var param = i === 1 ? thisWired : wired[i - 2];
                      if (argTypes[i].destructorFunction !== null) {
                        argTypes[i].destructorFunction(param);
                      }
                    }
                  }
                  return returns ? argTypes[0].fromWireType(rv) : void 0;
                };`;
if (source.includes(minInvokerOld)) {
  source = source.replace(minInvokerOld, minInvokerNew);
} else if (!source.includes('var invokerFn = function () {')) {
  throw new Error('OpenCV-craftInvokerFunction nicht gefunden (Paketversion geändert?)');
}

const minEmvalOld = 'var invokerFunction = newFunc(Function, params)(...args);';
const minEmvalNew = `var invokerFunction = function (obj, func, destructorsRef, args) {
                  var callArgs = [];
                  var offset = 0;
                  if (kind === 0) callArgs.push(obj);
                  for (var i = 0; i < argCount; ++i) {
                    callArgs.push(types2[i].readValueFromPointer(args + offset));
                    offset += types2[i].argPackAdvance;
                  }
                  var rv = kind === 1 ? Reflect.construct(func, callArgs) : func.call(...callArgs);
                  if (!retType.isVoid) {
                    return emval_returnValue(retType, destructorsRef, rv);
                  }
                };`;
if (source.includes(minEmvalOld)) {
  source = source.replace(minEmvalOld, minEmvalNew);
} else if (!source.includes('var invokerFunction = function (obj, func, destructorsRef, args) {')) {
  throw new Error('OpenCV-__emval_get_method_caller nicht gefunden (Paketversion geändert?)');
}

/* ONNX Runtime liefert Embind minifiziert: Die Aufrufer entstehen dort in
   einem IIFE-Ausdruck mit `pe = Function`. Der Ersatz bleibt ein Ausdruck,
   weil der Patch in einer Komma-Sequenz steht. */
const ortEmvalRe = /s = \(function\(se\) \{[\s\S]*?\}\)\(R\)\(\.\.\.G\)/;
const ortEmvalNew = `s = (function () {
              var embindArgCount = s;
              return function (obj, func, destructorsRef, args) {
                var callArgs = [];
                if (h === 0) callArgs.push(obj);
                var offset = 0;
                for (var i = 0; i < embindArgCount; ++i) {
                  callArgs.push(l[i].readValueFromPointer(args + offset));
                  offset += l[i].Db;
                }
                var rv = h === 1 ? Reflect.construct(func, callArgs) : func.call(...callArgs);
                return y.Ub ? void 0 : di(y, destructorsRef, rv);
              };
            })()`;
if (ortEmvalRe.test(source)) {
  source = source.replace(ortEmvalRe, ortEmvalNew);
} else if (!source.includes('var embindArgCount = s;')) {
  throw new Error('ONNX-Runtime-Embind-Aufrufer nicht gefunden (Version geändert?)');
}

/* Emscripten wählt in `fi` zwischen globalThis und einem Function-Konstruktor.
   Der Konstruktor wird zwar bei vorhandenem globalThis nicht ausgeführt, steht
   aber im Bundle und wird von der CSP-Prüfung als eval-Quelle gemeldet.
   `globalThis` ist in allen unterstützten Browsern vorhanden. */
const globalOld = 'var fi = () => typeof globalThis == "object" ? globalThis : Function("return this")();';
const globalNew = 'var fi = () => globalThis;';
if (source.includes(globalOld)) source = source.replace(globalOld, globalNew);

/* Bei explizitem WASM-Backend braucht der Host keine WebGPU-Probe. Chrome
   protokolliert jede requestAdapter()-Anfrage als Warnung, wenn kein Adapter
   da ist; die Pipeline läuft ohnehin in Wasm. */
const webgpuOld = '    const webgpuState = await detectWebGpuAvailability();';
const webgpuNew = '    const webgpuState = backend === "wasm" ? { available: false, reason: "WebGPU disabled (wasm backend)." } : await detectWebGpuAvailability();';
if (source.includes(webgpuOld)) {
  source = source.replace(webgpuOld, webgpuNew);
} else if (!source.includes(webgpuNew)) {
  throw new Error('PaddleOCR-WebGPU-Probe nicht gefunden (SDK-Version geändert?)');
}

for (const marker of ['new Function', 'new_(Function', 'newFunc(Function',
                      'pe = Function', 'Function("return this")']) {
  if (source.includes(marker)) {
    throw new Error('Im Paddle-Bundle ist weiterhin eine eval-Konstruktion vorhanden: ' + marker);
  }
}
fs.writeFileSync(file, source);
console.log('OK  Paddle-Bundle ohne eval gepatcht: ' + file);
