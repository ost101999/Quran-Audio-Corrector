-- Toggle / Summon المصحح الصوتي with Right Command (mapped to Fn) + R,
-- and toggle Recording with F3 (Mission Control key without Fn) only while the HUD is visible.
local DEV_COMMAND_PATH = "/Users/omarsherif/My Apps/المصحح الصوتي/project/dev.command"
local PACKAGED_APP_PATH = "/Applications/المصحح الصوتي.app"
local STATE_DIR = (os.getenv("HOME") or "") .. "/.quran-audio-corrector"
local HUD_PID_PATH = STATE_DIR .. "/hud.pid"
local HUD_VISIBLE_PATH = STATE_DIR .. "/hud.visible"
local MISSION_CONTROL_KEYCODE = 160

local isLaunchingCorrector = false
local consumedRecordKeyUp = false

local function readPidFile(path)
    local f = io.open(path, "r")
    if not f then return nil end
    local raw = f:read("*a")
    f:close()
    return raw and raw:match("^(%d+)") or nil
end

local function isHudVisible()
    return readPidFile(HUD_VISIBLE_PATH) ~= nil
end

local function hasNoModifiers(flags)
    return not flags.cmd and not flags.alt and not flags.ctrl and not flags.shift
end

local function launchCorrector()
    if isLaunchingCorrector then
        return
    end
    if hs.fs.attributes(PACKAGED_APP_PATH) then
        isLaunchingCorrector = true
        hs.application.launchOrFocus(PACKAGED_APP_PATH)
        hs.timer.doAfter(2.0, function() isLaunchingCorrector = false end)
    elseif hs.fs.attributes(DEV_COMMAND_PATH) then
        isLaunchingCorrector = true
        local task = hs.task.new("/bin/bash", function()
            isLaunchingCorrector = false
        end, { DEV_COMMAND_PATH })
        if task then
            task:setEnvironment({
                PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
                HOME = os.getenv("HOME") or "",
            })
            task:start()
            hs.timer.doAfter(3.0, function() isLaunchingCorrector = false end)
        else
            isLaunchingCorrector = false
        end
    end
end

local function toggleAudioCorrector()
    local pid = readPidFile(HUD_PID_PATH)
    if pid then
        local task = hs.task.new("/bin/kill", function(exitCode)
            if exitCode ~= 0 then
                os.remove(HUD_VISIBLE_PATH)
                os.remove(HUD_PID_PATH)
                launchCorrector()
            end
        end, { "-USR1", pid })
        if task and task:start() then
            return
        end
    end

    launchCorrector()
end

local function triggerAudioRecord()
    local pid = readPidFile(HUD_VISIBLE_PATH) or readPidFile(HUD_PID_PATH)
    if not pid then
        return
    end
    local task = hs.task.new("/bin/kill", function(exitCode)
        if exitCode ~= 0 then
            os.remove(HUD_VISIBLE_PATH)
            os.remove(HUD_PID_PATH)
        end
    end, { "-USR2", pid })
    if task then
        task:start()
    end
end

_G.toggleAudioCorrector = toggleAudioCorrector
_G.triggerAudioRecord = triggerAudioRecord

if _G.toggleAudioCorrectorTap then
    _G.toggleAudioCorrectorTap:stop()
end

_G.toggleAudioCorrectorTap = hs.eventtap.new({ hs.eventtap.event.types.keyDown }, function(event)
    if event:getKeyCode() ~= 15 then -- R key
        return false
    end

    local flags = event:getFlags()
    local rawFlags = event:rawFlags()
    -- Physical Right Command is remapped to Fn by Right Command to Fn.lua.
    local rightCommand = (rawFlags & 0x10) ~= 0
    local leftCommand = (rawFlags & 0x08) ~= 0
    local fnPressed = (flags.fn and not flags.cmd) or (rightCommand and not leftCommand and not flags.fn)

    if not fnPressed or flags.shift or flags.alt or flags.ctrl then
        return false
    end

    if event:getProperty(hs.eventtap.event.properties.keyboardEventAutorepeat) ~= 0 then
        return true
    end

    -- Defer out of eventtap callback immediately so macOS input never stalls.
    hs.timer.doAfter(0, toggleAudioCorrector)
    return true
end)

_G.toggleAudioCorrectorTap:start()

if _G.audioCorrectorRecordKeyTap then
    _G.audioCorrectorRecordKeyTap:stop()
end

_G.audioCorrectorRecordKeyTap = hs.eventtap.new({
    hs.eventtap.event.types.keyDown,
    hs.eventtap.event.types.keyUp
}, function(event)
    if event:getKeyCode() ~= MISSION_CONTROL_KEYCODE then
        return false
    end

    local eventType = event:getType()
    if eventType == hs.eventtap.event.types.keyUp then
        if consumedRecordKeyUp then
            consumedRecordKeyUp = false
            return true
        end
        return false
    end

    if not hasNoModifiers(event:getFlags()) or not isHudVisible() then
        return false
    end

    if event:getProperty(hs.eventtap.event.properties.keyboardEventAutorepeat) ~= 0 then
        return true
    end

    consumedRecordKeyUp = true
    hs.timer.doAfter(0, triggerAudioRecord)
    return true
end)

_G.audioCorrectorRecordKeyTap:start()

if _G.audioCorrectorRecordSysTap then
    _G.audioCorrectorRecordSysTap:stop()
end

_G.audioCorrectorRecordSysTap = hs.eventtap.new({ hs.eventtap.event.types.NSSystemDefined }, function(event)
    local ok, sysKey = pcall(event.systemKey, event)
    if not ok or not sysKey or sysKey.key ~= "EXPOSE_ALL" then
        return false
    end

    if not sysKey.down then
        if consumedRecordKeyUp then
            consumedRecordKeyUp = false
            return true
        end
        return false
    end

    if not hasNoModifiers(event:getFlags()) or not isHudVisible() then
        return false
    end

    if sysKey["repeat"] then
        return true
    end

    consumedRecordKeyUp = true
    hs.timer.doAfter(0, triggerAudioRecord)
    return true
end)

_G.audioCorrectorRecordSysTap:start()
