' Launch start-auth.ps1 with no visible console window.
'
' Used by the dsh-auth scheduled task (logon trigger). The task cannot call powershell.exe
' directly: Windows Terminal is the default terminal on this machine and opens a window for
' any console handed to it, even when the console was created hidden (-WindowStyle Hidden).
' wscript is a GUI-subsystem host, so its child never gets a console window on screen.
' Same trick as C:\Running\dsh\run-hidden.vbs (dsh-serve-watchdog).
'
' 0 = hidden window, True = wait, so the task stays "Running" while auth serves and
' the task's RestartOnFailure still sees a non-zero exit if uvicorn dies.
Option Explicit
Dim fso, sh, root, script, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
root   = fso.GetParentFolderName(WScript.ScriptFullName)
script = fso.BuildPath(root, "start-auth.ps1")
cmd    = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """"
sh.Run cmd, 0, True
