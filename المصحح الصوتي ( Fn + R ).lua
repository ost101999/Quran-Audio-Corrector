-- Toggle / Summon المصحح الصوتي with Right Command (mapped to Fn) + R.
local DEV_COMMAND_PATH = "/Users/omarsherif/My Apps/المصحح الصوتي/project/dev.command"
local PACKAGED_APP_PATH = "/Applications/المصحح الصوتي.app"
local HUD_PID_PATH = (os.getenv("HOME") or "") .. "/.quran-audio-corrector/hud.pid"

local isLaunchingCorrector = false

local function readHudPid()
    local f = io.open(HUD_PID_PATH, "r")
    if not f then return nil end
    local raw = f:read("*a")
    f:close()
    local pid = raw and raw:match("^(%d+)")
    return pid
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
    local pid = readHudPid()
    if pid then
        local task = hs.task.new("/bin/kill", function(exitCode)
            if exitCode ~= 0 then
                launchCorrector()
            end
        end, { "-USR1", pid })
        if task and task:start() then
            return
        end
    end

    launchCorrector()
end

_G.toggleAudioCorrector = toggleAudioCorrector

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
