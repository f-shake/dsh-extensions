<#
.SYNOPSIS
    按个人词表扫描一段 ASR 转写稿，列出所有候选误听（只报不改）。

.DESCRIPTION
    词表是 `personal/glossary.md`（不入库）。脚本只做**确定性的候选发现**：
    逐行找出词表里每个「误听写法」的出现位置，连行号、上下文一起打印；
    改不改、怎么改由模型按上下文判断——**命中不等于结论**。

    为什么需要它：几千字的口述稿，靠肉眼一定会漏；先把候选摊开，再逐条定夺。

    解析规则：
      - 只解析表头含「误听 / 错误 / 出现写法 / 误写」的表格（含「混用 / 误写」的产品统一表）；
      - 「勿改白名单」「待核实」这类表格自动跳过；
      - 表头与数据行之间隔着 `|---|` 分隔线的，按表头处理——所以两张表紧挨着也不会串；
      - 左列用 `、` 或 `/` 分隔多个写法；写法与正确值相同的自反规则自动丢弃；
      - 纯 ASCII 且不超过 4 字符的写法加词边界，避免 `po` 命中 `position`；
      - 表头识别不了的整张表会打印 `WARN:` 行，不静默丢弃。

    退出码：0 正常（有命中或零命中）· 1 输入缺失 · 2 词表缺失 · 3 词表解析出 0 条规则。

.PARAMETER TextFile
    待扫描的文本文件（UTF-8）。与 -Text 二选一。

.PARAMETER Text
    直接传一段文本（适合临时验证；中文经命令行可能被控制台编码影响，长文请用 -TextFile）。

.PARAMETER Glossary
    词表路径，默认 `<技能目录>\personal\glossary.md`。

.PARAMETER Context
    命中前后各取多少个字符做上下文，默认 18。

.PARAMETER MinLength
    「误听写法」的最短长度，默认 2；单字规则噪声太大，不建议调低。

.PARAMETER IgnoreCase
    英文规则按忽略大小写匹配。默认关闭——ASR 的大小写错误本身就是待修项，
    默认只抓词表里写明的那个错误写法。

.PARAMETER SelfTest
    跑内置断言，结束时打印 SELFTEST: OK。

.EXAMPLE
    pwsh -NoProfile -File .\glossary-scan.ps1 -TextFile .\稿子.txt

.EXAMPLE
    pwsh -NoProfile -File .\glossary-scan.ps1 -SelfTest
#>
[CmdletBinding(DefaultParameterSetName = 'File')]
param(
    [Parameter(ParameterSetName = 'File', Position = 0)]
    [string] $TextFile,

    [Parameter(ParameterSetName = 'Inline')]
    [string] $Text,

    [string] $Glossary = (Join-Path (Split-Path -Parent $PSScriptRoot) 'personal\glossary.md'),

    [int] $Context = 18,

    [int] $MinLength = 2,

    [switch] $IgnoreCase,

    [switch] $SelfTest
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$SeparatorPattern = '^\|[\s:\-\|]+$'
$HeaderPattern = '误听|错误|出现写法|误写'
# 这些表头是「有意跳过」的（白名单 / 待核实），不算识别失败
$KnownSkipHeaderPattern = '正确写法|写法|为什么别改|为何存疑|说明'
$script:ParseWarnings = [System.Collections.Generic.List[string]]::new()

function Get-GlossaryEntries {
    <# 从 markdown 表格解析替换规则 #>
    param(
        [string[]] $Lines,
        [int] $MinLength = 2
    )

    $entries = [System.Collections.Generic.List[object]]::new()
    $inTable = $false
    $isEntryTable = $false

    for ($i = 0; $i -lt $Lines.Count; $i++) {
        $t = $Lines[$i].Trim()
        if (-not $t.StartsWith('|')) {
            $inTable = $false
            $isEntryTable = $false
            continue
        }
        if ($t -match $SeparatorPattern) { continue }

        # 表头 = 下一行是分隔线的那一行；新表头意味着上一张表到此为止，
        # 这样两张表紧跟（中间没有空行）也不会把第二张表头当数据。
        $next = if ($i + 1 -lt $Lines.Count) { $Lines[$i + 1].Trim() } else { '' }
        if ($next -match $SeparatorPattern) {
            $inTable = $true
            $isEntryTable = $t -match $HeaderPattern
            if (-not $isEntryTable -and $t -notmatch $KnownSkipHeaderPattern) {
                $script:ParseWarnings.Add("第 $($i + 1) 行表头「$t」无法识别，整表未参与扫描")
            }
            continue
        }
        if (-not $inTable) {
            # 没有分隔线的表：首行按表头处理
            $inTable = $true
            $isEntryTable = $t -match $HeaderPattern
            if (-not $isEntryTable -and $t -notmatch $KnownSkipHeaderPattern) {
                $script:ParseWarnings.Add("第 $($i + 1) 行表头「$t」无法识别，整表未参与扫描")
            }
            continue
        }
        if (-not $isEntryTable) { continue }

        # `\|` 是转义竖线，不能当单元格分隔
        $cells = @($t.Trim('|') -split '(?<!\\)\|' | ForEach-Object { $_.Trim() -replace '\\\|', '|' })
        if ($cells.Count -lt 2) { continue }

        $right = $cells[1]
        if (-not $right -or $right -match '^[-—–]+$') { continue }
        $note = if ($cells.Count -ge 3) { $cells[2] } else { '' }

        foreach ($variant in ($cells[0] -split '[、/／]')) {
            $v = $variant.Trim()
            if ($v.Length -lt $MinLength) { continue }
            if ($v -ceq $right) { continue }   # 自反规则（A → A）没有意义；-ceq 才不会把大小写差异当自反
            $boundary = ($v -match '^[A-Za-z0-9]+$' -and $v.Length -le 4)
            $entries.Add([pscustomobject]@{
                    Wrong    = $v
                    Right    = $right
                    Note     = $note
                    Boundary = $boundary
                })
        }
    }
    return $entries
}

function New-Hit {
    param([string] $Line, [int] $Index, [string] $Wrong, [object] $Entry, [int] $Context = 18)

    $from = [Math]::Max(0, $Index - $Context)
    $len = [Math]::Min($Line.Length - $from, $Wrong.Length + 2 * $Context)
    $ctx = $Line.Substring($from, $len).Trim()
    if ($from -gt 0) { $ctx = '…' + $ctx }
    if ($from + $len -lt $Line.Length) { $ctx = $ctx + '…' }

    [pscustomobject]@{
        Wrong   = $Wrong
        Right   = $Entry.Right
        Note    = $Entry.Note
        Index   = $Index
        Context = ($ctx -replace '\s+', ' ')
    }
}

function Find-GlossaryHits {
    param(
        [object[]] $Entries,
        [string] $Body,
        [int] $Context = 18,
        [switch] $IgnoreCase
    )

    $comparison = if ($IgnoreCase) {
        [System.StringComparison]::OrdinalIgnoreCase
    } else {
        [System.StringComparison]::Ordinal
    }
    $regexOptions = if ($IgnoreCase) {
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    } else {
        [System.Text.RegularExpressions.RegexOptions]::None
    }

    $hits = [System.Collections.Generic.List[object]]::new()
    $lines = $Body -split "`r?`n"

    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        if (-not $line) { continue }

        foreach ($e in $Entries) {
            if ($e.Boundary) {
                $pattern = '(?<![A-Za-z0-9])' + [regex]::Escape($e.Wrong) + '(?![A-Za-z0-9])'
                foreach ($m in [regex]::Matches($line, $pattern, $regexOptions)) {
                    $hit = New-Hit -Line $line -Index $m.Index -Wrong $e.Wrong -Entry $e -Context $Context
                    $hit | Add-Member -NotePropertyName Line -NotePropertyValue ($i + 1)
                    $hit | Add-Member -NotePropertyName Col -NotePropertyValue ($m.Index + 1)
                    $hits.Add($hit)
                }
                continue
            }

            $start = 0
            while ($start -lt $line.Length) {
                $idx = $line.IndexOf($e.Wrong, $start, $comparison)
                if ($idx -lt 0) { break }
                $hit = New-Hit -Line $line -Index $idx -Wrong $e.Wrong -Entry $e -Context $Context
                $hit | Add-Member -NotePropertyName Line -NotePropertyValue ($i + 1)
                $hit | Add-Member -NotePropertyName Col -NotePropertyValue ($idx + 1)
                $hits.Add($hit)
                $start = $idx + 1
            }
        }
    }
    return @($hits | Sort-Object Line, Col)
}

function Write-Hits {
    param([object[]] $Hits)

    foreach ($h in $Hits) {
        $note = if ($h.Note) { " | $($h.Note)" } else { '' }
        '{0,5}:{1,-3} {2} → {3}{4}' -f $h.Line, $h.Col, $h.Wrong, $h.Right, $note
        '            ' + $h.Context
    }
}

# ── 自测 ────────────────────────────────────────────────────────────────
if ($SelfTest) {
    # 覆盖：误听表 + 产品表（表头「混用 / 误写」）+ 紧邻的白名单表（无空行）
    #       + 自反规则 + 短 ASCII 词边界 + 转义竖线
    $sampleGlossary = @(
        '| 误听写法 | 正确写法 | 依据 / 备注 |'
        '|---|---|---|'
        '| 汪主任 | 王主任 | 职务名，姓「王」 |'
        '| 林静、林靖 | 林靖 | 人名 |'
        '| 西陵、西岭 | 西陵 | 统一 |'
        '| po、SS | PORT | 缩写 |'
        '| A\|B | AB | 转义竖线 |'
        '| 混用 / 误写 | 统一为 | 依据 |'
        '|---|---|---|'
        '| iphone | iPhone | 官方写法 |'
        '| 正确写法 | 为什么别改 |'
        '|---|---|'
        '| 西山顶 | 本地真实地名 |'
    )
    $entries = Get-GlossaryEntries -Lines $sampleGlossary -MinLength $MinLength

    if ($entries.Count -ne 7) {
        throw "SELFTEST FAILED: 应解析出 7 条规则，实际 $($entries.Count)：$($entries.Wrong -join ',')"
    }
    if (@($entries | Where-Object { $_.Wrong -eq '西陵' }).Count -ne 0) {
        throw 'SELFTEST FAILED: 自反规则「西陵 → 西陵」没被丢弃'
    }
    if (@($entries | Where-Object { $_.Wrong -eq '西山顶' }).Count -ne 0) {
        throw 'SELFTEST FAILED: 白名单表被当成了替换规则'
    }

    $body = '今天汪主任说 position 不对，iphone 也在，西岭路过，A|B 备好。'
    $hits = Find-GlossaryHits -Entries $entries -Body $body -Context $Context

    if ($hits.Count -ne 4) {
        throw "SELFTEST FAILED: 应命中 4 处，实际 $($hits.Count)：$($hits.Wrong -join ',')"
    }
    if (@($hits | Where-Object { $_.Wrong -eq 'po' }).Count -ne 0) {
        throw 'SELFTEST FAILED: 「po」命中了 position，词边界没生效'
    }
    if ($hits[0].Line -ne 1 -or $hits[0].Col -ne 3) {
        throw "SELFTEST FAILED: 首个命中应 1:3，实际 $($hits[0].Line):$($hits[0].Col)"
    }
    if ($hits[0].Context -notmatch '汪主任') {
        throw "SELFTEST FAILED: 上下文没带出命中词：$($hits[0].Context)"
    }
    if (@($hits | Where-Object { $_.Wrong -eq 'A|B' }).Count -ne 1) {
        throw 'SELFTEST FAILED: 转义竖线单元格没解析出来'
    }
    if ($script:ParseWarnings.Count -ne 0) {
        throw "SELFTEST FAILED: 合法表不应产生警告：$($script:ParseWarnings -join '；')"
    }

    # 表头识别不了的整表要出声，不能静默丢弃
    $null = Get-GlossaryEntries -Lines @('| 甲 | 乙 |', '| 丙 | 丁 |') -MinLength $MinLength
    if ($script:ParseWarnings.Count -ne 1) {
        throw "SELFTEST FAILED: 无法识别的表头应产生 1 条警告，实际 $($script:ParseWarnings.Count)"
    }

    Write-Hits -Hits $hits
    "SELFTEST: OK（$($entries.Count) 条规则，$($hits.Count) 处命中）"
    exit 0
}

# ── 主流程 ──────────────────────────────────────────────────────────────
if (-not $Text -and -not $TextFile) {
    'USAGE: -TextFile <稿子.txt> | -Text "<文本>" | -SelfTest'
    exit 1
}
if ($TextFile -and -not (Test-Path -LiteralPath $TextFile)) {
    "MISSING_TEXT: $TextFile"
    exit 1
}
if (-not (Test-Path -LiteralPath $Glossary)) {
    "MISSING_GLOSSARY: $Glossary"
    '（个人词表不入库；没有它就只剩通用规则，见 SKILL.md §0）'
    exit 2
}

if (-not $Text) {
    $Text = Get-Content -LiteralPath $TextFile -Raw -Encoding utf8
}
if ($null -eq $Text -or $Text.Trim().Length -eq 0) {
    "EMPTY_TEXT: $TextFile"
    exit 1
}

$entries = Get-GlossaryEntries -Lines (Get-Content -LiteralPath $Glossary -Encoding utf8) -MinLength $MinLength
foreach ($w in $script:ParseWarnings) { "WARN: $w（表头应为「误听写法」或「混用 / 误写」）" }
if ($entries.Count -eq 0) {
    "NO_RULES: 从 $Glossary 解析出 0 条规则"
    '（检查表头是否为「误听写法」或「混用 / 误写」，以及左列是否有内容）'
    exit 3
}

$hits = Find-GlossaryHits -Entries $entries -Body $Text -Context $Context -IgnoreCase:$IgnoreCase

if ($hits.Count -eq 0) {
    "NO_HITS: $($entries.Count) 条规则，$($Text.Length) 字符，零命中"
    exit 0
}

Write-Hits -Hits $hits
''
"SCANNED: $($entries.Count) 条规则，$($Text.Length) 字符，命中 $($hits.Count) 处（候选，不是结论）"
exit 0
