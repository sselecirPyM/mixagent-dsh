import { test } from "node:test";
import assert from "node:assert/strict";

import { findWriteReason } from "../safety.js";

test("the scout guard blocks PowerShell write commands", () => {
	for (const command of [
		"Remove-Item foo.txt",
		"remove-item -Recurse build",
		"del foo.txt",
		"ri a",
		"Set-Content a.txt x",
		"Add-Content a x",
		"Clear-Content a",
		'"x" | Out-File a',
		"New-Item -ItemType File a",
		"Copy-Item a b",
		"Move-Item a b",
		"Rename-Item a b",
		"Get-Process | Stop-Process",
		"Invoke-WebRequest -OutFile x https://example.com",
		"cmd /c del a",
		'[IO.File]::WriteAllText("a", "x")',
		"Get-ChildItem | ForEach-Object { Remove-Item $_ }",
		"iex (Get-Content a.ps1 -Raw)",
		"Start-Process notepad",
		"echo x > a.txt",
	]) {
		assert.ok(findWriteReason(command), `should block: ${command}`);
	}
});

test("the scout guard lets read-only PowerShell and $null redirects through", () => {
	for (const command of [
		"Get-Content a.txt 2>$null",
		"dir > $null",
		"Get-ChildItem *>$null",
		"Get-ChildItem -Recurse src",
		'Select-String -Path *.js -Pattern "Remove-Item"',
		"Get-Content a | Out-String",
		"Write-Output hi",
		"Test-Path a; Get-Item a",
		"git log --oneline 2>&1",
		'rg "a > b" src',
	]) {
		assert.equal(findWriteReason(command), undefined, `should allow: ${command}`);
	}
});
