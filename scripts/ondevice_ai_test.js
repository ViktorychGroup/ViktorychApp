const assert = require("assert");
const fs = require("fs");
const device = require("../device.js");
const ai = require("../ondevice-ai.js");
// The Local AI page's registry and core checks ride along here so the smoke workflow runs them.
for (const extra of ["settings_registry_test.js", "local_ai_test.js"]) {
  require("child_process").execFileSync(process.execPath, [require("path").join(__dirname, extra)], { stdio: "inherit" });
}

function strong() {
  return { deviceMemory: 8, hardwareConcurrency: 8, saveData: false, onWifi: true, battery: 0.8, charging: true };
}

const balanced = device.normalize(null);
assert.strictEqual(ai.loadedModels().length, 0);
assert.strictEqual(ai.CATALOG.translateLocal.license, "CC-BY-4.0");
assert.strictEqual(ai.CATALOG.semanticLocal.license, "Apache-2.0");
assert.strictEqual(ai.CATALOG.webllm.license, "Llama-3.2");
assert.strictEqual(ai.CATALOG.detect.download, false);
assert.strictEqual(ai.CATALOG.spam.download, false);
assert.strictEqual(ai.CATALOG.translateLocal.bytes, device.AI_SIZES.translateLocal);
assert.strictEqual(ai.CATALOG.semanticLocal.bytes, device.AI_SIZES.semanticLocal);
assert.strictEqual(ai.CATALOG.webllm.bytes, device.AI_SIZES.webllm);
assert.ok(ai.CATALOG.webllm.credit.indexOf("Built with Llama") >= 0);
const catalog = JSON.stringify(ai.CATALOG).toLowerCase();
assert.strictEqual(catalog.indexOf("nllb"), -1);
assert.strictEqual(catalog.indexOf("cc-by-nc"), -1);
assert.strictEqual(catalog.indexOf("non-commercial"), -1);

assert.strictEqual(ai.detectSync("The parcel arrived yesterday and the gate was open.").code, "en");
assert.strictEqual(ai.detectSync("El paquete llegó ayer y la puerta estaba abierta para todos.").code, "es");
assert.strictEqual(ai.detectSync("Посылка пришла вчера и ворота были открыты для всех.").code, "ru");

assert.ok(ai.spamScore("Claim your free prize. Click here now.") >= 0.45);
assert.strictEqual(ai.likelySpam("Claim your free prize. Click here now.", "reply", { settings: balanced, signals: strong() }), true);
assert.strictEqual(ai.likelySpam("The parcel arrived yesterday and the gate was open.", "reply", { settings: balanced, signals: strong() }), false);
assert.strictEqual(ai.likelySpam("Claim your free prize. Click here now.", "reply", { settings: device.toggleAi(balanced, "spam"), signals: strong() }), false);

const hidden = ai.decorate("Claim your free prize. Click here now.", "dm", "en");
assert.strictEqual(hidden.hidden, true);
assert.ok(hidden.html.indexOf("odai-show") >= 0);
assert.ok(hidden.html.indexOf("Claim your free prize") < 0);
const key = hidden.html.match(/data-key="([^"]+)"/)[1];
ai.onAct("odai-show", { getAttribute: function () { return key; } }, {});
assert.strictEqual(ai.decorate("Claim your free prize. Click here now.", "dm", "en").hidden, false);

const summary = ai.summarizeExtract("The parcel arrived yesterday. The gate was open when it arrived. A second note described the weather. The last line only said goodbye to the street.", 2);
assert.ok(summary.length > 20);
assert.ok(summary.split(".").length < 5);
const grammar = ai.fixGrammar("teh parcel recieve a lot of care");
assert.ok(grammar.indexOf("The") === 0);
assert.ok(grammar.indexOf("receive") >= 0);
assert.ok(grammar.indexOf("teh") < 0);
assert.ok(ai.applyTone("I think maybe this is just fine", "direct").toLowerCase().indexOf("i think") < 0);
assert.strictEqual(ai.suggestionsFor("The parcel arrived yesterday.").length, 3);

const saved = [
  { id: "p1", text: "The parcel arrived yesterday and the gate was open." },
  { id: "p2", text: "The concert ticket is for the evening music show." }
];
const off = ai.searchSaved("package arrival", saved, { settings: balanced, signals: strong() });
assert.strictEqual(off.via, "off");
const semantic = device.toggleAi(balanced, "semantic");
const found = ai.searchSaved("package arrival", saved, { settings: semantic, signals: strong() });
assert.strictEqual(found.via, "hash");
assert.strictEqual(found.hits[0].post.id, "p1");

assert.strictEqual(ai.downloadAllowed({ signals: { saveData: true, onWifi: true, battery: 1, charging: true } }), false);
assert.strictEqual(ai.downloadAllowed({ signals: { saveData: false, onWifi: false, battery: 1, charging: true } }), false);
assert.strictEqual(ai.downloadAllowed({ signals: { saveData: false, onWifi: true, battery: 0.1, charging: false } }), false);
assert.strictEqual(ai.downloadAllowed({ signals: { saveData: false, onWifi: true, battery: 0.1, charging: true } }), true);
assert.strictEqual(ai.serverAllowed({ scope: "dm", settings: balanced }), false);
assert.strictEqual(ai.serverAllowed({ scope: "dm", settings: device.toggleAi(balanced, "dmServer") }), true);
assert.strictEqual(ai.serverAllowed({ scope: "post", settings: balanced }), true);
assert.strictEqual(ai.pairFor("en", "es"), "Xenova/opus-mt-en-es");
assert.strictEqual(ai.pairFor("en", "xx"), "");

const html = device.settingsHtml(balanced);
assert.ok(html.indexOf('data-act="device-ai-toggle"') >= 0);
assert.ok(html.indexOf("113.1 MB") >= 0);
assert.ok(html.indexOf("23.0 MB") >= 0);
assert.ok(html.indexOf("Allow server fallback for direct messages") >= 0);
assert.strictEqual(html.indexOf("device-webllm"), -1);
const index = fs.readFileSync("index.html", "utf8");
assert.strictEqual(index.indexOf("ondevice-ai.js"), -1);
assert.strictEqual(index.indexOf("ondevice-ai-worker.js"), -1);
const boot = fs.readFileSync("device.js", "utf8");
const start = boot.slice(boot.indexOf("function start("), boot.indexOf("function reset("));
assert.ok(/var run = function \(\) \{[\s\S]*ensure\("ondevice"\)/.test(start));
assert.ok(start.indexOf("requestIdleCallback(run") >= 0);
const worker = fs.readFileSync("ondevice-ai-worker.js", "utf8");
assert.ok(worker.indexOf('importScripts("./ondevice-ai.js")') >= 0);
assert.strictEqual(ai.cacheNames().cache, "viktorych-ai-models");
assert.strictEqual(ai.cacheNames().opfs, "vapp-ai");

const support = ai.support();
assert.strictEqual(typeof support.browsers, "string");
assert.ok(support.browsers.indexOf("Chrome") >= 0);

device.reset();
const opts = { settings: balanced, signals: strong(), device: device, scope: "post", target: "en" };
let serverCalls = 0;
let created = 0;

ai.translate("El paquete llegó ayer y la puerta estaba abierta para todos.", Object.assign({}, opts, {
  scope: "dm",
  env: { server: function () { serverCalls += 1; return "left the device"; } }
})).then(function (row) {
  assert.strictEqual(serverCalls, 0);
  assert.strictEqual(row.hidden, true);
  return ai.translate("El paquete llegó ayer y la puerta estaba abierta para todos.", Object.assign({}, opts, {
    env: { server: function () { serverCalls += 1; return "parcel text"; } }
  }));
}).then(function (row) {
  assert.strictEqual(serverCalls, 1);
  assert.strictEqual(row.via, "worker");
  assert.strictEqual(row.text, "parcel text");
  device.reset();
  device.rememberFail("ai", "chrome-translator", Date.now(), "source");
  created = 0;
  return ai.translate("El paquete llegó ayer y la puerta estaba abierta para todos.", Object.assign({}, opts, {
    env: {
      translator: { create: function () { created += 1; return { translate: function () { return "no"; } }; } },
      server: function () { return "after fail"; }
    }
  }));
}).then(function (row) {
  assert.strictEqual(created, 0);
  assert.strictEqual(row.text, "after fail");
  assert.strictEqual(device.sourceState("chrome-translator"), "fail");
  return ai.summarize(["The parcel arrived yesterday.", "The gate was open when it arrived.", "A later note described only the weather."], opts);
}).then(function (row) {
  assert.strictEqual(row.via, "extractive");
  assert.ok(row.text.indexOf("parcel") >= 0);
  return ai.compose("teh gate was open", Object.assign({}, opts, { kind: "grammar", scope: "dm" }));
}).then(function (row) {
  assert.strictEqual(row.via, "rules");
  assert.ok(row.text.indexOf("receive") < 0);
  assert.ok(row.text.indexOf("The") === 0);
  return ai.measure("buffer", function () {
    const buf = new Uint8Array(1024 * 1024);
    buf[0] = 1;
    return buf.byteLength;
  });
}).then(function (measured) {
  assert.strictEqual(measured.value, 1024 * 1024);
  assert.ok(measured.loadMs >= 0);
  assert.ok(measured.memoryBytes >= 0);
  assert.strictEqual(ai.loadedModels().length, 0);
  return ai.workerTask("translate", { text: "hola", model: "Xenova/opus-mt-es-en" }, {
    inline: true,
    loader: function (model, text) {
      assert.strictEqual(model, "Xenova/opus-mt-es-en");
      assert.strictEqual(text, "hola");
      return { text: "hello", bytes: 8 };
    }
  });
}).then(function (row) {
  assert.strictEqual(row.text, "hello");
  assert.ok(row.loadMs >= 0);
  assert.ok(ai.loadedModels().indexOf("Xenova/opus-mt-es-en") >= 0);
  ai.reset();
  const withModel = device.toggleAi(device.toggleAi(balanced, "semantic"), "semanticLocal");
  let modelLoads = 0;
  return new Promise(function (resolve, reject) {
    const first = ai.searchSaved("package arrival", saved, {
      settings: withModel,
      signals: strong(),
      loader: function (model, text) {
        modelLoads += 1;
        assert.strictEqual(model, "Xenova/all-MiniLM-L6-v2");
        const rows = Array.isArray(text) ? text : [text];
        return {
          vectors: rows.map(function (line) {
            return String(line).indexOf("parcel") >= 0 || String(line).indexOf("package") >= 0 ? [1, 0] : [0, 1];
          })
        };
      },
      onRank: function () {
        try { resolve(ai.searchSaved("package arrival", saved, { settings: withModel, signals: strong() })); }
        catch (err) { reject(err); }
      }
    });
    assert.strictEqual(first.via, "hash");
    assert.strictEqual(first.hits[0].post.id, "p1");
  }).then(function (ranked) {
    assert.ok(modelLoads >= 1);
    assert.strictEqual(ranked.via, "minilm");
    assert.strictEqual(ranked.hits[0].post.id, "p1");
    const page = fs.readFileSync("ondevice-ai.js", "utf8");
    assert.strictEqual(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(page), false);
    assert.strictEqual(page.indexOf("@" + "reader"), -1);
    assert.strictEqual(ai.composeUiOn({ settings: balanced, signals: strong(), device: device }), true);
    assert.strictEqual(ai.composeUiOn({ settings: device.applyLevel("light"), signals: strong(), device: device }), false);
    const composeFile = fs.readFileSync("x-compose.js", "utf8");
    assert.strictEqual(composeFile.indexOf("odai-chips"), -1);
    assert.ok(composeFile.indexOf("xc-ai-btn") >= 0);
    assert.ok(composeFile.indexOf("data-kind=\"suggest\"") >= 0);
    assert.ok(composeFile.indexOf("replyMode") >= 0);
    let created = 0;
    let servers = 0;
    return ai.compose("teh gate was open", Object.assign({}, opts, {
      kind: "grammar",
      scope: "post",
      server: false,
      timeout: 40,
      env: {
        rewriter: {
          availability: function () { return "unavailable"; },
          create: function () { created += 1; return new Promise(function () {}); }
        },
        server: function () { servers += 1; return "from a server"; }
      }
    })).then(function (row) {
      assert.strictEqual(created, 0);
      assert.strictEqual(servers, 0);
      assert.strictEqual(row.via, "rules");
      assert.ok(row.text.indexOf("The") === 0);
      device.reset();
      created = 0;
      return ai.compose("teh gate was open", Object.assign({}, opts, {
        kind: "grammar",
        scope: "post",
        server: false,
        timeout: 40,
        env: {
          proofreader: {
            availability: function () { return "available"; },
            create: function () { created += 1; return new Promise(function () {}); }
          }
        }
      }));
    }).then(function (row) {
      assert.strictEqual(created, 1);
      assert.strictEqual(row.via, "rules");
      assert.ok(row.text.indexOf("The") === 0);
      device.reset();
      return ai.compose("teh gate was open", Object.assign({}, opts, {
        kind: "grammar",
        scope: "post",
        server: false,
        env: {
          proofreader: {
            availability: function () { return "readily"; },
            create: function () {
              return { proofread: function () { return { correctedInput: "The gate was open." }; } };
            }
          }
        }
      }));
    }).then(function (row) {
      assert.strictEqual(row.via, "chrome");
      assert.strictEqual(row.text, "The gate was open.");
      return ai.compose("The parcel arrived yesterday.", Object.assign({}, opts, {
        kind: "suggest",
        scope: "post",
        server: false,
        env: {
          prompt: {
            availability: function () { return "available"; },
            create: function () {
              return { prompt: function () { return "Thanks for the note.\nWhat time did it arrive?"; } };
            }
          }
        }
      }));
    }).then(function (row) {
      assert.strictEqual(row.via, "chrome");
      assert.strictEqual(row.suggestions.length, 2);
      assert.ok(row.suggestions[0].indexOf("Thanks") === 0);
      const formal = ai.applyTone("I can't really stay", "formal");
      assert.ok(formal.toLowerCase().indexOf("cannot") >= 0);
      assert.ok(formal.toLowerCase().indexOf("really") < 0);
      var stored = balanced;
      var mirror = {
        read: function () { return stored; },
        aiFeatureOn: device.aiFeatureOn,
        featureOn: device.featureOn,
        signals: function () { return strong(); }
      };
      assert.strictEqual(ai.composeUiOn({ device: mirror, signals: strong() }), true);
      stored = device.applyLevel("light");
      assert.strictEqual(ai.composeUiOn({ device: mirror, signals: strong() }), false);
      return ai.compose("teh gate was open", {
        device: mirror,
        signals: strong(),
        kind: "grammar",
        server: false
      }).then(function (row) {
        assert.strictEqual(row.via, "off");
        stored = balanced;
        return ai.compose("teh gate was open", {
          device: mirror,
          signals: strong(),
          kind: "grammar",
          server: false
        });
      }).then(function (row) {
        assert.strictEqual(row.via, "rules");
        assert.ok(row.text.indexOf("The") === 0);
        console.log("on-device ai tests ok");
      });
    });
  });
}).catch(function (err) {
  console.error(err);
  process.exit(1);
});
