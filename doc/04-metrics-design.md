# 统计指标与维度设计

## 1. 统计维度

### 1.1 时间维度

| 维度 | 说明 | 查询参数 |
|------|------|---------|
| 日 | 单日统计 | `period=day&date=2026-04-07` |
| 周 | 自然周（周一至周日） | `period=week&date=2026-04-07` (所在周) |
| 月 | 自然月 | `period=month&date=2026-04` |
| 自定义日期段 | 任意起止日期 | `period=custom&start=2026-01-01&end=2026-03-31` |
| 全部 | 所有历史数据 | `period=all` |

### 1.2 过滤维度

| 维度 | 说明 | 是否必须 |
|------|------|---------|
| 模型 | 按AI模型过滤或不过滤 | 可选，默认不过滤 |
| 用户 | 按用户名过滤 | 可选 |
| Agent | 按编程Agent过滤 | 可选 |
| 机器名 | 按hostname过滤 | 可选 |

### 1.3 下钻维度

支持从汇总数据向下逐级展开：

```
全局汇总
  └── 按用户展开
        └── 按机器名展开
              └── 按Agent展开
                    └── 按模型展开
                          └── 按会话展开
```

## 2. 统计指标

### 2.1 Token消耗

| 指标 | 字段 | 说明 |
|------|------|------|
| 输入Token | token_input | 发送给模型的token数 |
| 输出Token | token_output | 模型生成的token数 |
| 合计Token | token_total | 输入+输出 |
| 缓存读取Token | token_cache_read | 从缓存读取（不计费或折扣） |
| 缓存写入Token | token_cache_write | 写入缓存的token数 |

### 2.2 会话与对话

| 指标 | 说明 |
|------|------|
| 会话数 | 独立session的数量 |
| 对话轮次数 | 用户-AI交互的来回次数总和 |
| 平均每会话轮次 | 对话轮次数 / 会话数 |
| 平均会话时长 | 总时长 / 会话数 |

### 2.3 文件变更

| 指标 | 说明 |
|------|------|
| 生成文件数 | 新创建的文件数量 |
| 修改文件数 | 修改的已有文件数量 |
| 新增行数 | 所有文件中新增的代码行数 |
| 删除行数 | 所有文件中删除的代码行数 |
| 净变更行数 | 新增 - 删除 |

### 2.4 Skill使用

| 指标 | 聚合方式 | 说明 |
|------|---------|------|
| Skill使用次数（不聚合） | 逐条列出 | 显示每次skill调用的详情 |
| Skill使用个数（聚合） | 按skill名称GROUP BY | 使用了多少种不同的skill |
| 各Skill使用次数 | 按skill名称SUM | 每种skill各被使用了多少次 |
| 单会话Skill使用次数 | 按session_id过滤 | 某次会话中skill的使用次数 |
| 单会话Skill使用个数 | 按session_id过滤后DISTINCT | 某次会话中使用了多少种skill |

### 2.5 Tool使用

| 指标 | 聚合方式 | 说明 |
|------|---------|------|
| Tool使用次数 | 逐条/SUM | 工具调用的总次数 |
| Tool使用个数 | COUNT DISTINCT | 使用了多少种不同的工具 |
| 各Tool使用次数 | 按tool名称SUM | 每种tool各被使用了多少次 |
| 单会话Tool使用次数 | 按session_id过滤 | 某次会话中tool的使用次数 |
| 单会话Tool使用个数 | 按session_id过滤后DISTINCT | 某次会话中使用了多少种tool |
| 单对话Tool使用次数 | 按conversation_turn过滤 | 某轮对话中tool的使用次数 |
| 单对话Tool使用个数 | 按conversation_turn过滤后DISTINCT | 某轮对话中使用了多少种tool |

## 3. 排名规则

### 3.1 排名指标选择

用户可选择以下任一指标作为排名依据：

- Token合计消耗（默认）
- Token输入消耗
- Token输出消耗
- 会话数
- 对话轮次数
- 文件生成/修改数量
- 代码行变更量
- Tool使用次数
- Skill使用次数

### 3.2 排名输出格式

```json
{
  "period": { "type": "week", "start": "2026-03-31", "end": "2026-04-06" },
  "metric": "token_total",
  "model_filter": null,
  "rankings": [
    {
      "rank": 1,
      "username": "leon",
      "token_total": 1250000,
      "token_input": 980000,
      "token_output": 270000,
      "session_count": 45,
      "conversation_turns": 320,
      "files_created": 12,
      "files_modified": 87,
      "lines_added": 2340,
      "lines_removed": 890,
      "tool_use_count": 567,
      "tool_distinct_count": 15,
      "skill_use_count": 23,
      "skill_distinct_count": 6,
      "drilldown": {
        "by_hostname": [
          { "hostname": "leon-mbp", "token_total": 800000, "session_count": 30 },
          { "hostname": "leon-linux", "token_total": 450000, "session_count": 15 }
        ],
        "by_agent": [
          { "agent": "claude-code", "token_total": 1000000, "session_count": 35 },
          { "agent": "copilot-cli", "token_total": 250000, "session_count": 10 }
        ]
      }
    }
  ]
}
```

## 4. 图表设计

### 4.1 Dashboard图表

| 图表 | 类型 | 数据 |
|------|------|------|
| Token消耗趋势 | 折线图 | 按日的token_input/output/total |
| 用户排名 | 柱状图 + 全指标表格 | 所有指标同时展示，点击列头排序 |
| Agent分布 | 饼图 | 各Agent的使用占比 |
| 模型使用分布 | 饼图 | 各模型的token消耗占比 |
| 会话热力图 | 热力图 | 按小时x星期的会话分布 |
| Tool/Skill使用排名 | 横向柱状图 | 各Tool/Skill的使用频率 |
| 机器使用分布 | 表格 | 各机器名的使用统计 |
