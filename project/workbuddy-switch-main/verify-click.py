# TEMP-VERIFY: 启动新构建的 exe，用真实鼠标点击底部栏 ✦ 按钮，
# 枚举 OS 窗口确认「积分悬浮窗」是否创建、位置是否正确。用完即删。
import ctypes
import ctypes.wintypes as wt
import os
import subprocess
import sys
import time

EXE = sys.argv[1] if len(sys.argv) > 1 else r"F:\WorkBuddy\2026-10-11-16-28-54\project\workbuddy-switch-main\target\release\wb-switch-rust.exe"

u32 = ctypes.WinDLL("user32", use_last_error=True)
u32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))

EnumProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)


def windows_of(pid):
    found = []

    @EnumProc
    def cb(hwnd, _):
        p = wt.DWORD()
        u32.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
        if p.value == pid and u32.IsWindow(hwnd):
            title = ctypes.create_unicode_buffer(512)
            u32.GetWindowTextW(hwnd, title, 512)
            r = wt.RECT()
            u32.GetWindowRect(hwnd, ctypes.byref(r))
            found.append(
                {
                    "hwnd": hwnd,
                    "visible": bool(u32.IsWindowVisible(hwnd)),
                    "rect": (r.left, r.top, r.right - r.left, r.bottom - r.top),
                    "title": title.value,
                }
            )
        return True

    u32.EnumWindows(cb, 0)
    return found


def click(x, y):
    u32.SetCursorPos(int(x), int(y))
    time.sleep(0.15)
    u32.mouse_event(0x0002, 0, 0, 0, 0)  # LEFTDOWN
    time.sleep(0.06)
    u32.mouse_event(0x0004, 0, 0, 0, 0)  # LEFTUP
    time.sleep(1.3)


subprocess.run(["taskkill", "/F", "/IM", "wb-switch-rust.exe"], capture_output=True)
time.sleep(1.2)

log = open("verify-click-app.log", "wb")
proc = subprocess.Popen(
    [EXE],
    cwd=os.path.dirname(EXE),
    stdout=log,
    stderr=subprocess.STDOUT,
)
print("启动 exe, pid =", proc.pid, flush=True)

# 等主窗口出现且可见
main = None
for _ in range(40):
    time.sleep(1)
    wins = windows_of(proc.pid)
    cands = [w for w in wins if w["visible"] and "workbuddy-switch" in w["title"]]
    if cands:
        main = cands[0]
        break

if main is None:
    print("!! 未找到主窗口，窗口列表：")
    for w in windows_of(proc.pid):
        print("   ", w)
    proc.terminate()
    sys.exit(1)

print("主窗口:", main, flush=True)
L, T, W, H = main["rect"]

print("\n--- 点击前的窗口 ---")
for w in windows_of(proc.pid):
    print("   ", w)

u32.SetForegroundWindow(main["hwnd"])
time.sleep(0.5)

# 底部栏右侧聚类里，✦ 紧挨版本号左侧；用一小组候选点，命中即停
success = False
for dy in (700, 715, 730, 685, 745):
    for dx in (105, 115, 95, 125):
        click(L + dx, T + dy)
        wins = windows_of(proc.pid)
        hit = [w for w in wins if "积分悬浮窗" in w["title"]]
        if hit:
            print(f"\n*** 命中 ✦ 按钮: 偏移=({dx},{dy}) 绝对坐标=({L+dx},{T+dy})")
            success = True
            break
    if success:
        break

print("\n--- 点击后的窗口 ---")
for w in windows_of(proc.pid):
    print("   ", w)

print("\n结论:", "积分悬浮窗已创建 ✅" if success else "未检测到积分悬浮窗 ❌")
proc.terminate()
time.sleep(0.5)
try:
    proc.kill()
except Exception:
    pass
