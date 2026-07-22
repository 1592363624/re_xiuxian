/**
 * 更新日志数据
 *
 * 说明：
 *   - currentVersion：当前版本号，发布新版时修改此处以触发用户弹窗
 *   - changelog 数组首项为最新版本，按版本倒序排列
 *   - type 取值：feature（新功能）/ fix（修复）/ balance（数值平衡）/ optimize（优化）/ other（其他）
 *   - 首项为本地实际更新内容；fallback 项仅在无法连接 GitHub API 时显示
 *
 * @author 修仙游戏开发组
 * @updated 2026-07-22
 */
export const currentVersion = 'v0.3.4_BETA'; // 🔔 发布新版时，请修改此版本号以触发用户弹窗

// 🛡️ 兜底数据：仅在无法连接 GitHub API 时显示
export const changelog = [
  {
    version: 'v0.3.4_BETA',
    date: '2026-07-22',
    sections: [
      {
        title: '新增功能',
        type: 'feature',
        items: [
          '【大五行幻世轮线·法宝深线第四条（最终线）】玩法文档第19节完整闭环：被动战斗驱动成长，是四条法宝深线中唯一一条非主动操作推进的线。',
          '五行定相系统：6 种相位（轮转/金/水/木/火/土），每种相位提供不同战力加成倾向（金偏破甲暴击/水偏控制恢复/木偏气血回复/火偏爆发攻击/土偏防御减免/轮转均衡），7 天冷却可切换。',
          '五行相生相克联动：金克木、木克土、土克水、水克火、火克金；克制对手时悟印获取+50%，被克时-30%；轮转相位不受相克影响。',
          '悟印被动积累：祭出大五行幻世轮参与斗法（PVE/PVP/副本）自动积累悟印经验，无需主动操作。PVP胜20/PVE胜10/副本胜15，越级挑战额外加成，每日上限100。',
          '10 阶成长体系：phase_multiplier 1.0→3.0，每阶提升相位加成倍率；7 阶解锁悟印翻倍（幻世初显）；5 阶解锁轮转技能。',
          '轮转技能（5阶解锁）：开启后战斗中每 3 回合自动切换五行相位，适应对手属性，消耗神识维持。',
          '新增 4 个 API 接口：GET /api/artifact-deep-line/five-element-wheel/status + POST set-phase/insight/wheel-spin。',
          '新增 2 个战斗系统集成方法：addInsightExp（战斗结算自动积累悟印）+ getFiveElementWheelCombatBonus（战力加成计算），供战斗系统调用。',
          '四条法宝深线全部完成，形成完整差异化矩阵：战斗向主动（血魔剑单线博弈+虚天鼎双线分支）+ 辅助向主动（掌天瓶多功能并行）+ 被动成长向（大五行幻世轮战斗驱动）。'
        ]
      },
      {
        title: '文档与测试',
        type: 'other',
        items: [
          '大五行幻世轮线端到端测试 123/123 通过（23 阶段：鉴权/参数校验/配置完整性/状态查询/定相流程/悟印提示/PVE胜利/PVP相克加成/被克减成/副本胜利/PVE失败/连续升阶/每日上限/轮转5阶前锁定/轮转开关/7阶翻倍/境界差加成/战力加成计算/未装备静默返回/死亡状态校验）。',
          'OpenAPI 文档同步 +4 paths（法宝深线总计 23 路径：血魔剑 6 + 虚天鼎 4 + 掌天瓶 9 + 大五行幻世轮 4）。',
          '功能对比清单更新：大五行幻世轮线 ❌→✅，法宝深线四条线全部完成，累计测试 1693→1816 通过。'
        ]
      },
      {
        title: '版本说明',
        type: 'other',
        items: [
          'v0.3.4_BETA 聚焦法宝深线第四条线（大五行幻世轮线）完整闭环，四条法宝深线全部完成。',
          '法宝深线系统里程碑：23 路径 + 4 条线 + 445 条端到端测试通过，形成完整差异化玩法矩阵。'
        ]
      }
    ]
  },
  {
    version: 'v0.3.3_BETA',
    date: '2026-07-22',
    sections: [
      {
        title: '新增功能',
        type: 'feature',
        items: [
          '【掌天瓶线·法宝深线第三条】玩法文档第19节完整闭环：辅助向多功能并行成长，与血魔剑（战斗向）/虚天鼎（战斗向）形成差异化玩法。',
          '7 大功能模块并行：凝液(6h冷却→绿液) + 炼丹稳变(2h冷却，加成稳定/变异丹药) + 药园(12h，需黄枫谷) + 星台(12h，需星宫) + 养竹(4h→化竹) + 养木(24h自动产出魂木) + 养树(48h自动产出灵木)。',
          '绿液经济驱动：凝液周期性产出掌天瓶绿液，是炼丹/药园/星台/养竹等模块的核心消耗材料，形成完整经济闭环。',
          '宗门联动：药园需加入黄枫谷、星台需加入星宫，通过 PlayerSect 模型校验宗门归属，强化宗门系统价值。',
          '新增 9 个 API 接口：GET /api/artifact-deep-line/sky-bottle/status + POST condense/alchemy/garden/star-platform/nurture-bamboo/transform-bamboo/nurture-wood/nurture-tree。',
          '材料线渐进：养竹产出竹材→化竹进阶；养木/养树 24h/48h 自动周期产出，长线养成节奏。'
        ]
      },
      {
        title: 'Bug 修复',
        type: 'fix',
        items: [
          '修复 gardenBoost/starPlatformBoost 中引用不存在的 player.sect_id 字段导致宗门校验永远失败的 Bug，改用 PlayerSect 模型查询宗门归属。',
          '修复 Sequelize TEXT 字段 deep_line_state 自定义 get()/set() 访问器导致状态修改丢失的 Bug：get() 每次返回新对象，修改其属性不会同步回内部 raw string。统一改为显式覆盖子对象 equipment.deep_line_state = { ...deep_line_state, sky_bottle: state }。',
          '修复 _initSkyBottleState 同引用赋值导致 equipment.changed("deep_line_state") 返回 false 的问题，改为始终创建新顶层对象。',
          '修复测试脚本中 dharma 槽位被虚天鼎占用时违反 uk_player_slot 唯一约束的问题。'
        ]
      },
      {
        title: '文档与测试',
        type: 'other',
        items: [
          '掌天瓶线端到端测试 116/116 通过（19 阶段：鉴权/参数校验/配置完整性/状态查询/凝液/炼丹/药园/星台/养竹/化竹/养木/养树/绿液不足/死亡状态/凝液上限）。',
          'OpenAPI 文档同步 +9 paths（法宝深线总计 19 路径：血魔剑 6 + 虚天鼎 4 + 掌天瓶 9）。',
          '功能对比清单更新：掌天瓶线 ❌→✅，累计测试 1577→1693 通过。'
        ]
      },
      {
        title: '版本说明',
        type: 'other',
        items: [
          'v0.3.3_BETA 聚焦法宝深线第三条线（掌天瓶线）完整闭环，三条线已形成战斗向（血魔剑/虚天鼎）+ 辅助向（掌天瓶）的差异化玩法矩阵。',
          '剩余法宝深线：大五行幻世轮线 1 条线待实现。'
        ]
      }
    ]
  },
  {
    version: 'v0.3.2_BETA',
    date: '2026-07-22',
    sections: [
      {
        title: '新增功能',
        type: 'feature',
        items: [
          '【虚天鼎/乾蓝冰焰线·法宝深线第二条】玩法文档第19节完整闭环：双线并行成长（鼎本体10阶防御向 def_bonus 100→4600 + 乾蓝冰焰10阶攻击向 atk_bonus 80→2240）。',
          '化极不可逆分支：紫罗极火（攻击+50%，每回合反噬5%气血，高风险高收益）vs 乾蓝冰焰强化（攻击+20%，无反噬，低风险低收益），需灵焰≥7阶 + 消耗神识500+灵石200000+乾蓝寒髓10。',
          '神识消耗系统对接：通宝消耗100 / 炼焰消耗200 / 化极消耗500，直接操作 PlayerDivineSense 模型行级锁扣减。',
          '与血魔剑线差异化设计：血魔剑=单线+双值博弈+封鞘蓄势；虚天鼎=双线并行+神识消耗+化极不可逆分支+无封鞘。',
          '新增 4 个 API 接口：GET /api/artifact-deep-line/xutian-cauldron/status + POST advance + POST refine-flame + POST polarize。',
          '新增 2 个物品：乾蓝冰焰（从虚天鼎中抽离出的上古灵焰）+ 紫罗极火（乾蓝冰焰经化极后的极致灵焰）。',
          '成功率递减机制：1-5阶 100%成功率，6-10阶递减（90%/80%/70%/60%/50%），失败材料全损不降级。'
        ]
      },
      {
        title: 'Bug 修复',
        type: 'fix',
        items: [
          '修复 ArtifactDeepLineService 中 5 处 WebSocketNotificationService.notifyPlayerUpdate(...).catch() 调用导致的 TypeError（notifyPlayerUpdate 是同步方法返回 boolean，非 Promise），改为 try-catch 包裹。'
        ]
      },
      {
        title: '文档与测试',
        type: 'other',
        items: [
          '虚天鼎/乾蓝冰焰线端到端测试 53/53 通过（12 阶段：鉴权/参数校验/配置完整性/状态查询/通宝推进/冷却校验/炼焰前置条件/完整流程/化极不可逆/战力加成验证）。',
          'OpenAPI 文档同步 +4 paths（法宝深线总计 10 路径：血魔剑 6 + 虚天鼎 4）。',
          '功能对比清单更新：虚天鼎/乾蓝冰焰线 ❌→✅，累计测试 1577/1577 通过。'
        ]
      },
      {
        title: '版本说明',
        type: 'other',
        items: [
          'v0.3.2_BETA 聚焦法宝深线第二条线（虚天鼎/乾蓝冰焰线）完整闭环，与血魔剑残契线形成差异化玩法。',
          '剩余法宝深线：掌天瓶线 + 大五行幻世轮线 2 条线待实现。'
        ]
      }
    ]
  },
  {
    version: 'v0.3.1_BETA',
    date: '2026-07-22',
    sections: [
      {
        title: '新增功能',
        type: 'feature',
        items: [
          '【灵兽升星·通灵升星】玩法文档第8节完整闭环：满级灵兽溢出经验凝练为兽魂（exp_per_soul=1000 + max_soul_per_feed=100 上限），配合妖丹与灵石进行通灵升星。',
          '升星概率博弈：1→2 星 100% 成功率，逐级递减至 9→10 星 5% 成功率；失败不降级但材料全损 + 忠诚度-5~15，保留策略博弈深度。',
          '4 种稀有度消耗倍率：common 1.0x / rare 1.5x / epic 2.0x / legendary 3.0x，高稀有度灵兽升星更珍贵。',
          '招牌特性系统：4 种灵兽（青云狼/火焰狮/冰魄狐/腾蛇）各拥有 3星/5星两个招牌特性（如青云狼-狼王之怒+10%攻击 / 裂空爪无视15%防御），升星至 3/5 星自动激活。',
          '新增 2 个 API 接口：GET /api/spirit-beast/:beastId/upgrade-preview（升星预览）+ POST /api/spirit-beast/:beastId/upgrade-star（执行升星）。',
          '新增 2 个物品：妖丹（妖兽内丹凝炼而成的纯净丹元）+ 兽魂（满级灵兽溢出经验凝练而得的兽魂精魄）。',
          '新增数据库字段：spirit_beasts.beast_soul（兽魂数量）+ spirit_beasts.last_upgrade_star_time（最后升星时间，用于冷却限制）。',
          '【切磋木人排行榜每日结算】业务流程测试完成（24/24 通过）：GM 接口鉴权 + 参数校验 + 正常结算 + 幂等性 + 字段完整性 + 称号注册 + 调度器配置 + 化神木人首通称号校验。'
        ]
      },
      {
        title: '功能更正',
        type: 'other',
        items: [
          '功能对比清单同步更正：搜寻节点/定星实际已实现（AscensionService.searchNode/stabilizeNode + routes/ascension.js 2 接口）。',
          '功能对比清单同步更正：法则转换实际已实现（LawService + routes/law.js 4 接口：profile/convert-divine-sense/convert-fragment/convert）。',
          '功能对比清单同步更正：血魔剑残契线实际已完整实现（ArtifactDeepLineService 7 个方法：血祭/镇压/雷洗/铭印/剑鞘蓄势/过期结算/战斗加成）。',
          '功能对比清单同步更正：GM 灵兽管理实际已完成（批次4-2-Ext4：9 接口 + 前端管理界面 + 41/41 测试通过）。'
        ]
      },
      {
        title: 'Bug 修复',
        type: 'fix',
        items: [
          '修复 _checkLevelUp 满级经验处理：满级灵兽继续获得的经验现在按 1000:1 凝练为兽魂字段（而非清零），为灵兽升星系统提供材料来源。',
          '修复测试脚本 InventoryService 依赖问题：独立测试脚本中 ConfigLoader 未初始化导致 addItem 报错，改为初始化 ConfigLoader + 直接操作 Item 模型绕过容量检查。'
        ]
      },
      {
        title: '文档与测试',
        type: 'other',
        items: [
          'OpenAPI 文档同步：+2 paths（/api/spirit-beast/{beastId}/upgrade-preview + /upgrade-star），灵兽系统路径总数达 42 个。',
          '端到端测试：灵兽升星系统 113/113 通过（13 个测试阶段：登录/鉴权/参数校验/预览字段/配置加载/招牌特性/材料不足/升星成功/冷却/失败场景/特性激活/满级凝练/数据还原）。',
          '功能对比清单更新：累计测试 1524/1524 通过（v0.3.0 的 1411 + 本轮 113）。'
        ]
      },
      {
        title: '版本说明',
        type: 'other',
        items: [
          '当前显示的为本地实际更新内容。',
          '如需查看 GitHub 远程更新日志，请确保网络连接正常。'
        ]
      }
    ]
  },
  {
    version: 'fallback', 
    date: new Date().toLocaleDateString(),
    sections: [
      {
        title: '获取失败',
        type: 'fix', 
        items: [
          '无法连接到 GitHub 获取最新更新日志。',
          '请检查网络连接，或稍后再试。'
        ]
      },
      {
        title: '版本说明',
        type: 'other',
        items: [
          '当前显示的为本地兜底信息。',
          '实际更新内容请查看代码仓库提交记录。'
        ]
      }
    ]
  }
];
