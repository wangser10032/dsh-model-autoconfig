/**
 * 浏览器端：按 provider + model 记住最后一次成功选择的思考档位。
 *
 * 数据只存在当前浏览器的 localStorage，不进入 settings.yaml，也不在设备间同步。
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-autoconfig',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var STORAGE_KEY = 'dsh-model-autoconfig.effort-memory.v1'
    var VERSION = 1

    function entryKey(provider, model) {
      return JSON.stringify([provider, model])
    }

    function emptyMemory() {
      return { version: VERSION, efforts: {} }
    }

    function readMemory() {
      if (typeof localStorage === 'undefined') return emptyMemory()
      try {
        var parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
        if (parsed === null || parsed.version !== VERSION || typeof parsed.efforts !== 'object' || Array.isArray(parsed.efforts)) {
          return emptyMemory()
        }
        return { version: VERSION, efforts: Object.assign({}, parsed.efforts) }
      } catch (_) {
        return emptyMemory()
      }
    }

    function writeMemory(memory) {
      if (typeof localStorage === 'undefined') return
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(memory))
      } catch (_) {
        // 隐私模式、配额或浏览器策略禁止存储时静默降级为宿主原行为。
      }
    }

    function modelInfo(directory, provider, modelId) {
      var state = directory && directory.store && directory.store.getSnapshot
        ? directory.store.getSnapshot()
        : null
      if (!state || !Array.isArray(state.groups)) return null
      var group = state.groups.find(function (item) { return item.id === provider })
      if (!group || !Array.isArray(group.models)) return null
      return group.models.find(function (item) { return item.id === modelId }) || null
    }

    function rememberedEffort(directory, provider, modelId) {
      var model = modelInfo(directory, provider, modelId)
      if (!model || !model.reasoning || !Array.isArray(model.reasoning.efforts)) return { found: false }

      var memory = readMemory()
      var key = entryKey(provider, modelId)
      if (!Object.prototype.hasOwnProperty.call(memory.efforts, key)) return { found: false }

      var effort = memory.efforts[key]
      if (effort === null) {
        if (model.reasoning.defaultEffort === undefined) return { found: true, effort: undefined }
      } else if (typeof effort === 'string' && model.reasoning.efforts.some(function (item) { return item.id === effort })) {
        return { found: true, effort: effort }
      }

      // 模型更新后旧档位失效：删除记忆，交还模型默认档位。
      delete memory.efforts[key]
      writeMemory(memory)
      return { found: false }
    }

    function rememberSelection(directory, selection) {
      var model = modelInfo(directory, selection.provider, selection.model)
      var memory = readMemory()
      var key = entryKey(selection.provider, selection.model)

      if (!model || !model.reasoning || !Array.isArray(model.reasoning.efforts)) {
        if (Object.prototype.hasOwnProperty.call(memory.efforts, key)) {
          delete memory.efforts[key]
          writeMemory(memory)
        }
        return
      }

      var effort = selection.reasoningEffort
      if (effort === undefined) effort = model.reasoning.defaultEffort
      memory.efforts[key] = effort === undefined ? null : effort
      writeMemory(memory)
    }

    function withRememberedEffort(directory, selection) {
      var state = directory.store && directory.store.getSnapshot
        ? directory.store.getSnapshot()
        : null
      var current = state && state.current
      var switchingModel = !current || current.provider !== selection.provider || current.model !== selection.model
      if (!switchingModel) return selection

      var remembered = rememberedEffort(directory, selection.provider, selection.model)
      if (!remembered.found) return selection

      var next = { provider: selection.provider, model: selection.model }
      if (remembered.effort !== undefined) next.reasoningEffort = remembered.effort
      return next
    }

    function patchDirectory(directory) {
      if (!directory || typeof directory.select !== 'function' || directory.__dshMacEffortMemory) return null
      var original = directory.select
      directory.__dshMacEffortMemory = true
      directory.select = async function (selection) {
        var resolved = withRememberedEffort(directory, selection)
        await original.call(directory, resolved)
        rememberSelection(directory, resolved)
      }
      return function () {
        if (directory.select !== original) directory.select = original
        delete directory.__dshMacEffortMemory
      }
    }

    var inject = ['modelDirectories']

    function apply(ctx) {
      ctx.inject(['modelDirectories'], function (scope) {
        var resolver = scope.modelDirectories
        if (!resolver || typeof resolver.directoryFor !== 'function') return

        var originalDirectoryFor = resolver.directoryFor
        var restorers = new Map()
        function ensure(directory) {
          if (!restorers.has(directory)) {
            var restore = patchDirectory(directory)
            if (restore) restorers.set(directory, restore)
          }
          return directory
        }

        // 先覆盖已经创建的会话目录，再接住之后创建的目录。
        var liveDirectories = resolver.live && resolver.live.directories
        if (liveDirectories && typeof liveDirectories.values === 'function') {
          for (var directory of liveDirectories.values()) ensure(directory)
        }
        resolver.directoryFor = function (sessionId) {
          return ensure(originalDirectoryFor.call(this, sessionId))
        }

        return function () {
          if (resolver.directoryFor !== originalDirectoryFor) resolver.directoryFor = originalDirectoryFor
          for (var restore of restorers.values()) restore()
          restorers.clear()
        }
      })
    }

    exports.STORAGE_KEY = STORAGE_KEY
    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
