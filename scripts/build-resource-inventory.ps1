param(
    [string]$SourceRoot = "D:\云\学习资料",
    [string]$OutputDirectory = ".\outputs\resource-inventory"
)

$ErrorActionPreference = "Stop"
$resolvedRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$previewableExtensions = @(".pdf", ".ppt", ".pptx", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".txt", ".jpg", ".jpeg", ".png")
$downloadOnlyExtensions = @(".sav", ".mp4")
$blockedExtensions = @(".exe")
$sensitiveTerms = @("个人信息", "身份证", "手机号", "电话", "姓名", "学生信息", "通讯录")
$copyrightTerms = @("教材", "完整版", "电子书")

$files = Get-ChildItem -LiteralPath $resolvedRoot -File -Recurse
$records = foreach ($file in $files) {
    $relativePath = $file.FullName.Substring($resolvedRoot.Length).TrimStart("\")
    $parts = $relativePath -split "\\"
    $course = if ($parts.Count -ge 1) { $parts[0] } else { "未分类" }
    $category = if ($parts.Count -ge 3) { $parts[1] } else { "其他" }
    $extension = $file.Extension.ToLowerInvariant()
    $riskFlags = [System.Collections.Generic.List[string]]::new()

    if ($blockedExtensions -contains $extension) { $riskFlags.Add("blocked_executable") }
    if ($category -eq "教材" -or ($copyrightTerms | Where-Object { $relativePath -like "*$_*" })) {
        $riskFlags.Add("copyright_review")
    }
    if ($sensitiveTerms | Where-Object { $relativePath -like "*$_*" }) {
        $riskFlags.Add("privacy_review")
    }
    if ($extension -eq ".mp4") { $riskFlags.Add("large_video") }

    $delivery = if ($blockedExtensions -contains $extension) {
        "quarantine"
    } elseif ($riskFlags.Contains("copyright_review") -or $riskFlags.Contains("privacy_review")) {
        "review"
    } elseif ($downloadOnlyExtensions -contains $extension) {
        "download_only"
    } elseif ($previewableExtensions -contains $extension) {
        "preview_and_download"
    } else {
        "review"
    }

    [pscustomobject]@{
        course = $course
        category = $category
        fileName = $file.Name
        extension = $extension
        sizeBytes = $file.Length
        relativePath = $relativePath
        fullPath = $file.FullName
        delivery = $delivery
        riskFlags = ($riskFlags -join "|")
        sha256 = ""
    }
}

$records | Export-Csv -LiteralPath (Join-Path $OutputDirectory "resource-inventory.csv") -NoTypeInformation -Encoding UTF8

$summary = [ordered]@{
    generatedAt = (Get-Date).ToString("o")
    sourceRoot = $resolvedRoot
    fileCount = $records.Count
    totalBytes = ($records | Measure-Object -Property sizeBytes -Sum).Sum
    byExtension = @($records | Group-Object extension | Sort-Object Count -Descending | ForEach-Object {
        [ordered]@{ extension = $_.Name; count = $_.Count; bytes = ($_.Group | Measure-Object sizeBytes -Sum).Sum }
    })
    byCourse = @($records | Group-Object course | Sort-Object Name | ForEach-Object {
        [ordered]@{ course = $_.Name; count = $_.Count; bytes = ($_.Group | Measure-Object sizeBytes -Sum).Sum }
    })
    byDelivery = @($records | Group-Object delivery | Sort-Object Name | ForEach-Object {
        [ordered]@{ delivery = $_.Name; count = $_.Count; bytes = ($_.Group | Measure-Object sizeBytes -Sum).Sum }
    })
}
$summary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $OutputDirectory "resource-summary.json") -Encoding UTF8

$safe = $records | Where-Object { $_.delivery -eq "preview_and_download" }
$safe | Export-Csv -LiteralPath (Join-Path $OutputDirectory "safe-first-batch.csv") -NoTypeInformation -Encoding UTF8

$review = $records | Where-Object { $_.delivery -in @("review", "quarantine") }
$review | Export-Csv -LiteralPath (Join-Path $OutputDirectory "needs-review.csv") -NoTypeInformation -Encoding UTF8

Write-Output ("Inventory: {0} files, {1:N2} GiB" -f $records.Count, ($summary.totalBytes / 1GB))
Write-Output ("Safe first batch: {0} files, {1:N2} GiB" -f $safe.Count, (($safe | Measure-Object sizeBytes -Sum).Sum / 1GB))
Write-Output ("Needs review/quarantine: {0} files, {1:N2} GiB" -f $review.Count, (($review | Measure-Object sizeBytes -Sum).Sum / 1GB))
