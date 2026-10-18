# 轻量评论核验

适用于已经提交、已知文章URL及评论编号的记录。只发匿名HTTP GET，不调用模型、不开浏览器、不扫描站点地图、不重复提交。每次最多4个请求并发，单页25秒预算、2.5MB限制，最多5跳且只允许同一来源主机（含www别名）。

## 运行

依赖：Python 3.9+、系统curl、BeautifulSoup。需要时安装：

```sh
python3 -m pip install -r outreach/requirements-comment-watch.txt
python3 outreach/comment_watch.py --quiet-unchanged
```

本机DNS代理使用198.18.0.0/15映射公网域名，已实测确认，因此当前电脑使用：

```sh
python3 outreach/comment_watch.py --fake-ip-dns --quiet-unchanged
```

该选项只允许已提供域名的DNS结果使用这一网段；不允许私网IP字面量、其他私网网段或跨主机跳转。其他环境默认不需要此选项。使用系统证书校验，不关闭TLS验证。无法访问时保留unknown/blocked，不自动换浏览器或绕过挑战。

默认读取 `outreach/run/comment-experiment/submissions.json`，可用 `--manifest PATH` 指定其他已提交记录；每条需有domain、url、comment_id、comment、website，可选followup_dates。拒绝带unapproved、moderation-hash、preview参数的私人预览地址。

## 判定与输出

- public_link：公开HTML中的指定评论编号包含匹配正文，并在该评论内发现目标域名链接。保存真实href、rel、robots，不将nofollow宣称为dofollow。
- public_comment_only：评论公开，但该评论内未找到目标链接。
- not_public：公开HTML没有指定评论，或仍带审核提示。
- page_missing：404/410，仅描述页面返回值，不推断投稿被拒绝。
- blocked / unknown：反爬、限流、网络、非HTML、正文不符等，需要时再诊断。

HTML检查会排除脚本、模板、noscript、hidden及明确隐藏样式。无法执行JS或完整判断外部CSS，所以public_link是静态HTTP证据；首次出现时可做一次浏览器复核。评论正文经排版改写、分页或纯JS渲染可能需要人工确认。脚本不会根据缺失把投递账本改成failed，也不会自动抬success或释放claim。投递账本仍以state API维护。

`--quiet-unchanged` 在状态、链接属性、robots均不变且无到期复核时输出0字节。首次运行输出基线；变化或第7/30天里程碑输出精简JSON。时间戳、ETag和耗时变化不会触发通知。304复用同一manifest和最终URL的上次证据。HTTP失败保留ever_public，避免丢失曾上线历史；unknown不等于掉链。

结果写在manifest旁：

- watch-cache.json：持久基线和已报告里程碑，带文件锁、临时文件原子替换。
- watch-cache-latest.json：最近一次结果、计数、变化、耗时。

通过Codex heartbeat运行仍会有任务唤醒的模型开销；省掉的是逐页浏览、截图、全文读取和反复判断。脚本自身无模型请求。监控收到空输出即结束评论部分，不再读取10个HTML或打开网页。

## 测试

```sh
python3 -m unittest discover -s outreach/tests -p 'test_comment_watch.py'
bash outreach/tests/smoke.sh
```

包括链接域名伪装、侧栏误匹配、隐藏模板、待审核预览、HTTP错误、304、无变化、rel变化、7/30天只报告一次、网络失败保持历史和本机DNS代理例外范围。
