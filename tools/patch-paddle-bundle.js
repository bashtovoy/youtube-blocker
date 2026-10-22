#!/usr/bin/env node
/* patch-paddle-bundle.js — entfernt die beiden eval-Stellen aus OpenCV.js.
   Chrome-MV3-Erweiterungsseiten erlauben kein `unsafe-eval`; OpenCVs Embind
   erzeugt sonst beim Laden Fehlerklassen und dynCall-Wrapper über
   `new Function(...)`. Beide Stellen lassen sich ohne Verhaltensänderung
   durch normale Funktionen ersetzen:
   - createNamedFunction: Closure mit gesetztem Function.name,
   - makeDynCaller: Function.prototype.bind.
   Das Skript bricht ab, wenn eine Stelle fehlt oder danach noch `new Function`
   im Bundle steht — so fällt eine SDK-Version mit anderem Embind-Layout sofort
   beim Setup auf. */
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
if (!source.includes(namedOld)) {
  throw new Error('OpenCV-createNamedFunction-Muster nicht gefunden (SDK-Version geändert?)');
}
source = source.replace(namedOld, namedNew);

const dynOld = 'return new Function("dynCall", "rawFunction", body)(dynCall2, rawFunction);';
const dynNew = 'return dynCall2.bind(null, rawFunction);';
if (!source.includes(dynOld)) {
  throw new Error('OpenCV-makeDynCaller-Muster nicht gefunden (SDK-Version geändert?)');
}
source = source.replace(dynOld, dynNew);

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
if (!source.includes(invokerOld)) {
  throw new Error('OpenCV-craftInvokerFunction-Muster nicht gefunden (SDK-Version geändert?)');
}
source = source.replace(invokerOld, invokerNew);

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
if (!source.includes(emvalOld)) {
  throw new Error('OpenCV-__emval_get_method_caller-Muster nicht gefunden (SDK-Version geändert?)');
}
source = source.replace(emvalOld, emvalNew);

/* Bei explizitem WASM-Backend braucht der Host keine WebGPU-Probe. Chrome
   protokolliert jede requestAdapter()-Anfrage als Warnung, wenn kein Adapter
   da ist; die Pipeline läuft ohnehin in Wasm. */
const webgpuOld = '    const webgpuState = await detectWebGpuAvailability();';
const webgpuNew = '    const webgpuState = backend === "wasm" ? { available: false, reason: "WebGPU disabled (wasm backend)." } : await detectWebGpuAvailability();';
if (!source.includes(webgpuOld)) {
  throw new Error('PaddleOCR-WebGPU-Probe nicht gefunden (SDK-Version geändert?)');
}
source = source.replace(webgpuOld, webgpuNew);

if (source.includes('new Function') || source.includes('new_(Function')) {
  throw new Error('Im Paddle-Bundle ist weiterhin eine eval-Konstruktion vorhanden');
}
fs.writeFileSync(file, source);
console.log('OK  Paddle-Bundle ohne eval gepatcht: ' + file);
