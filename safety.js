/**
 * Heuristic guard that keeps the scout's shell usage read-only.
 */

const WRITE_PATTERNS = [
	/\b(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|chgrp|ln|tee|truncate|dd|shred|install)\b/,
	/\bsed\b[^|;&]*\s-[a-zA-Z]*i/, // sed -i
	/\bperl\b[^|;&]*\s-[a-zA-Z]*i/, // perl -i
	/\d*>{1,2}\s*\S*/, // output redirection (> file, >> file, 2> file)
	/\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|uninstall|update|ci|link|publish|run|exec)\b/,
	/\bnpx\b/,
	/\bpip3?\s+(install|uninstall)\b/,
	/\b(apt|apt-get|brew|choco|winget)\s+(install|remove|purge|upgrade|update|uninstall)\b/,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|restore|clean|stash|cherry-pick|revert|tag|init|clone|apply|am|rm|mv)\b/,
	/\b(sudo|su|kill|pkill|killall|reboot|shutdown|systemctl|service)\b/,
	/\b(vi|vim|nano|emacs|code)\b/,
	/\bxargs\b[^|;&]*\b(rm|mv|cp|sed)\b/,
];

/**
 * PowerShell verbs whose cmdlets change files, processes, services, packages or settings
 * (Remove-Item, Set-Content, Out-File, New-Item, Copy-Item, Stop-Process, Invoke-WebRequest, …).
 */
const PWSH_WRITE_CMDLET =
	/\b(Remove|Set|Add|Clear|Out|New|Copy|Move|Rename|Stop|Start|Restart|Install|Uninstall|Export|Expand|Compress|Register|Unregister|Enable|Disable|Update|Save|Publish|Invoke|Mount|Dismount|Suspend|Resume|Reset|Grant|Revoke|Unblock|Write|Tee)-[A-Za-z]+\b/gi;

/** Cmdlets with a write verb that only print, wait, navigate or build in-memory values. */
const PWSH_HARMLESS_CMDLETS = new Set(
	[
		"Write-Output", "Write-Host", "Write-Verbose", "Write-Debug", "Write-Warning", "Write-Information", "Write-Error", "Write-Progress",
		"Out-String", "Out-Host", "Out-Null", "Out-Default",
		"Start-Sleep", "Set-Location", "Set-StrictMode", "Set-Variable", "New-Variable", "Clear-Variable", "Clear-Host",
		"New-Object", "New-TimeSpan", "New-Guid", "Add-Member", "Add-Type",
	].map((name) => name.toLowerCase()),
);

const PWSH_PATTERNS = [
	// Write aliases at command position: del/erase/rd/ri (Remove-Item), ni (New-Item), ren/rni, mi/move, copy/cpi,
	// ac/sc/clc (Add/Set/Clear-Content), spps (Stop-Process), saps/start (Start-Process), iex, ii (Invoke-Item).
	/(?:^|[|;&({]\s*)(del|erase|rd|ri|ni|ren|rni|mi|move|copy|cpi|ac|sc|clc|spps|saps|start|iex|ii)(?=\s|$)/im,
	/-OutFile\b/i,
	/\[(?:System\.)?IO\.(?:File|Directory)\]::(?:Write|Append|Create|Delete|Move|Copy|Replace|Open|Set)/i,
	/\bcmd(?:\.exe)?\s+\/[ck]\b/i,
];

/** Redirections that never write a file (bash /dev/null, PowerShell $null, stream merges). */
const HARMLESS_REDIRECTS = /[\d*]*>>?\s*\/dev\/null|[\d*]*>>?\s*\$null\b|\d*>&\d|&>\s*\/dev\/null/gi;

/** Strip quoted strings so search patterns like rg "a > b" are not mistaken for redirections. */
function stripQuoted(command) {
	return command.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/** Returns a reason string if the command looks like it modifies state, otherwise undefined. */
export function findWriteReason(command) {
	const normalized = stripQuoted(command).replace(HARMLESS_REDIRECTS, " ");
	for (const pattern of WRITE_PATTERNS) {
		const match = normalized.match(pattern);
		if (match) return `"${match[0].trim()}" may modify files or system state`;
	}
	for (const match of normalized.matchAll(PWSH_WRITE_CMDLET)) {
		if (!PWSH_HARMLESS_CMDLETS.has(match[0].toLowerCase())) return `"${match[0]}" may modify files or system state`;
	}
	for (const pattern of PWSH_PATTERNS) {
		const match = normalized.match(pattern);
		if (match) return `"${(match[1] ?? match[0]).trim()}" may modify files or system state`;
	}
	return undefined;
}
