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
 * @updated 2026-07-23
 */
export const currentVersion = 'v0.4.3_BETA'; // 🔔 发布新版时，请修改此版本号以触发用户弹窗

// 🛡️ 兜底数据：仅在无法连接 GitHub API 时显示
export const changelog = [
  {
    version: 'v0.4.3_BETA',
    date: '2026-07-23',
    sections: [
      {
        title: '新增功能：拍卖竞价系统（多人经济博弈·竞价+防秒杀+灵石冻结+自动结算）',
        type: 'feature',
        items: [
          '【多人经济核心·差异化设计】拍卖聚焦"竞价博弈"（多人竞争 + 倒计时 + 防秒杀），与万宝楼"标价直购"（即时成交）形成差异化，与当铺（典当周转）、股市（长期投资）共同构成完整经济闭环。',
          '【防秒杀机制】拍卖结束前 60 秒内有人竞价，自动延长 60 秒，最多延长 3 次，杜绝"最后一秒偷鸡"。',
          '【灵石冻结机制】竞价时立即扣除竞价者灵石（冻结），被他人超越时自动退还前一个竞价者，保证成交价真实有效。',
          '【手续费快照】创建拍卖时快照当前手续费率（默认 5%），避免后续配置变更影响在拍拍卖的结算。',
          '【自动结算调度器】AuctionSchedulerService 每 30 秒批量结算到期拍卖：有人竞价则成交（物品给得标者，灵石扣手续费给卖家），无人竞价则物品退回卖家，独立事务保证失败不影响其他拍卖。',
          '【撤销补偿】卖家可主动撤销拍卖，若已有人竞价需支付补偿费（当前价 2%），物品退回储物袋。',
          '【WebSocket 实时推送】新竞价通知卖家、被超越通知前竞价者、得标/结算通知双方，5 种事件全覆盖。',
          '【数据库】migration_0070 新建 auctions（20字段，含 BIGINT 灵石/DECIMAL 手续费率/防秒杀延长计数）+ auction_bids 两表，5 索引优化查询。',
          '【配置中心化】auction_data.json 完整配置（时长/起拍价/加价/手续费/防秒杀/卖家限制/竞价者限制/调度器/列表/WebSocket），全可热更新。',
          '【后端接口】新增 10 个 API：配置/列表/详情/创建/出价/撤销/我的拍卖/我的竞价/GM结算/GM调度器状态。',
          '【后端服务】AuctionService（约 940 行）9 个公开方法 + AuctionSchedulerService 调度器，BigInt 安全处理 + 事务 + 行级锁保证并发安全。',
          '【前端 API】auction.ts 新增 10+ TypeScript 接口 + 10 个 API 方法，类型完整覆盖配置/摘要/详情/竞价/撤销/GM。',
          '【前端 UI】AuctionPanel.vue 四 Tab 面板（拍卖列表/创建拍卖/我的拍卖/我的竞价）+ 详情 Modal（含竞价历史+出价二次确认）+ 撤销补偿提示，玫红主题体现竞价热烈感。',
          '【OpenAPI】新增 10 个路径定义 + 10 个 schema（AuctionConfig/AuctionSummary/AuctionBidRecord/AuctionDetail/CreateAuctionResult/PlaceBidResult/CancelAuctionResult/MyBidItem/GmSettleResult/GmSchedulerStatus），可导入 Apifox。',
          '【端到端测试】22/22 断言通过：登录/配置/储物袋/创建/列表/详情/自己出价失败/我的拍卖/我的竞价/撤销/GM结算/GM调度器/404/401 全覆盖。'
        ]
      },
      {
        version: 'v0.4.2_BETA',
        date: '2026-07-23',
        sections: [
          {
            title: '新增功能：洞天绘卷系统（多人社交·洞府全景风貌评级+题词互动+风貌榜）',
            type: 'feature',
            items: [
              '【多人社交核心·差异化设计】洞天绘卷聚焦"洞府全景展示+风貌竞争+文化互动"，与万宝阁"物品展示+鉴赏获利"形成差异化：万宝阁是个人收益导向，绘卷是社交竞争导向。',
              '【风貌评级算法】综合四维得分：设施分(5项等级×权重2) + 景观分(已布置+5) + 展品分(数量×3+品质加分 rare+2/epic+4/legendary+6/mythic+10) + 人气分(访客×0.5+留言×0.5+展品热度×0.2)。',
              '【六品评级】凡品(0+)/灵品(21+)/玄品(41+)/地品(61+)/天品(81+)/仙品(101+)，六档评级徽章差异化配色（灰→绿→蓝→紫→橙→金渐变）。',
              '【题词互动】拜访道友洞府后可题词留言（限20字），每日5次上限，同一洞府每日仅1次；被题词者获2点声望（每日上限20点），声望 BigInt 安全累加。',
              '【题词清理】每洞府保留最近20条题词，超量自动清理最旧记录，避免数据膨胀。',
              '【风貌排行榜】全服洞府风貌综合得分 Top 20 排行榜，批量查询+内存分组统计优化避免 N+1 查询。',
              '【WebSocket 通知】题词后通过 cave_scroll_inscribed 事件实时通知被题词的洞府主人，主人即时知晓有人题词。',
              '【数据库】migration_0069 新建 cave_scroll_inscriptions 表（target_player_id+inscriber_id+content+created_at，含2索引），完整记录题词历史。',
              '【配置中心化】cave_data.json social.scroll 节点完整配置（rating评级权重阈值/inscribe题词限制声望/ranking榜单），全可热更新。',
              '【后端接口】新增 4 个 API：GET /scroll/me + GET /scroll/player/:playerId + POST /scroll/:playerId/inscribe + GET /scroll/ranking。',
              '【后端服务】CaveSocialService 新增 10 个方法（约600行）：评级算法+得分计算+展品/人气统计+绘卷数据构建+题词校验链+声望发放+排行榜批量统计。',
              '【前端 API】caveSocial.ts 新增 8 个 TypeScript 接口 + 4 个 API 方法，类型完整覆盖全景/评级/得分/题词/榜单。',
              '【前端 UI】CaveSocialPanel.vue 新增第 8 个"绘卷"Tab：说明区 + 模式切换（我的绘卷/题词道友）+ 我的绘卷（全景+评级+得分明细+近期题词）+ 查看他人（输入ID+全景+题词输入+题词录）+ 风貌榜，含题词结果弹窗（声望明细）。',
              '【OpenAPI】新增 4 个路径定义 + 8 个 schema（CaveScroll/ScrollPanorama/ScrollRatingTier/ScrollScoreBreakdown/ScrollInscription/InscribeScrollResult/ScrollRankingItem/ScrollRankingResult），可导入 Apifox。'
            ]
          },
      {
        title: '新增功能：万宝阁展品系统（多人社交·收藏展示+鉴赏+社交博弈联动）',
        type: 'feature',
        items: [
          '【多人社交核心】洞府主人可将珍贵物品上架至万宝阁展示，拜访者可鉴赏展品获得修为灵感，有概率触发"顿悟"，形成"炫耀收藏-鉴赏获利-声望积累"社交循环。',
          '【上架机制】从背包选择物品上架（扣除1件），最多6个展位，最低品质要求精良(uncommon)以上，同物品不可重复上架；取下时物品归还背包并清零展品热度。',
          '【鉴赏顿悟】每日可鉴赏3次，同展品每日仅可鉴赏1次；基础修为=50+品质×30，15%概率触发顿悟（修为×3）并获1小时修炼加成+15%buff。',
          '【展品热度与声望】展品被鉴赏累计热度值，全服热度榜展示热门展品；rare以上展品被鉴赏时为主人带来声望奖励（高品质额外加成），声望实时发放。',
          '【洞天寻宝联动·财富外露】展品越多"财富外露"越明显，寻宝成功率上升（每展品+2%，上限+15%），形成"展示炫耀 vs 被盗风险"博弈。',
          '【洞天寻宝联动·珍宝护体】legendary以上展品"珍宝护体"提升大阵防御（每件+3%防御），高品质展品既是炫耀也是护阵宝物，缓解被盗风险。',
          '【数据库】migration_0068 新建 cave_exhibits + cave_exhibit_appreciations 两表（含3索引+唯一约束），完整记录展品与鉴赏历史。',
          '【配置中心化】cave_data.json social.treasure_pavilion 节点完整配置（开关/展位数/品质门槛/鉴赏次数/顿悟概率/热度声望/寻宝联动），全可热更新。',
          '【后端接口】新增 6 个 API：GET /exhibits + POST /exhibits/list + DELETE /exhibits/:id + GET /exhibits/player/:id + POST /exhibits/:id/appreciate + GET /exhibits/heat-board。',
          '【WebSocket 通知】顿悟时通过 cave_exhibit_enlightened 事件实时通知展品主人，主人即时知晓有人因自己展品顿悟。',
          '【物品锁定安全】上架时从背包真实扣除物品（inventoryService.removeItem），取下时归还，防止伪造/复制；BigInt 安全处理声望累加。',
          '【前端 API】caveSocial.ts 新增 8 个 TypeScript 接口 + 6 个 API 方法，类型完整覆盖展品/鉴赏/热度榜。',
          '【前端 UI】CaveSocialPanel.vue 新增第 7 个"万宝阁"Tab：玩法说明 + 我的展品管理（上架表单+展品列表+取下）+ 鉴赏他人展品（输入ID+展品列表+鉴赏）+ 热度榜，含取下确认弹窗与鉴赏结果弹窗（顿悟特效）。',
          '【品质色阶映射】6 档品质差异化徽章（common灰/uncommon绿/rare蓝/epic紫/legendary橙/mythic玫红），品质色一目了然。',
          '【OpenAPI】新增 6 个路径定义 + CaveExhibit schema（12字段含 enum 品质约束），可导入 Apifox。'
        ]
      },
      {
        title: '修复：注册接口报错 PlayerService.initializePlayer is not a function',
        type: 'fix',
        items: [
          '【根因】PlayerService.initializePlayer 定义为 static 静态方法，但模块导出的是实例（module.exports = new PlayerService()），auth 路由以实例方式调用时访问不到静态方法，导致注册接口返回 500 内部错误。',
          '【修复】将 initializePlayer 从静态方法改为实例方法（去掉 static 关键字），与模块导出方式保持一致；唯一调用点 auth.js 以实例方式调用，修复后注册流程恢复正常。',
          '【影响】修复前新玩家无法注册（已有账号登录不受影响）；万宝阁展品鉴赏测试因此 Bug 无法创建第二账号，修复后 30/30 端到端测试全部通过。',
          '【验证】第二账号注册成功并完成鉴赏流程测试（exp_gained=110=rare品质正确数值，热度+1，顿悟逻辑就绪）。'
        ]
      },
      {
        title: '修复：神识对决面板 TS 泛型语法导致前端编译失败',
        type: 'fix',
        items: [
          '【根因】DivineSenseDuelPanel.vue 使用 <script setup>（未启用 lang="ts"），却在 defineEmits 处使用 TS 泛型语法 defineEmits<{ (e: "close"): void }>()，Vue SFC 编译器按 JS 解析报错 Unexpected token，导致 vite build 整体失败。',
          '【修复】改为运行时声明 defineEmits(["close"])，与项目其它 <script setup>（无 lang="ts"）文件风格一致，功能等价。',
          '【验证】vite build 重新执行，316 modules transformed 全部成功，0 错误；万宝阁展品系统前端代码（CaveSocialPanel.vue + caveSocial.ts）一并编译通过。'
        ]
      }
    ]
  },
  {
    version: 'v0.4.0_BETA',
    date: '2026-07-22',
    sections: [
      {
        title: '新增功能：接待/驱逐访客系统（多人社交博弈·与洞天寻宝联动）',
        type: 'feature',
        items: [
          '【社交博弈核心】洞府主人可对接待访客进行接待（赠予临时增益buff）/ 驱逐（封锁拜访+寻宝24h）/ 忽略，与洞天寻宝联动形成多人社交博弈闭环。',
          '【接待增益】接待消耗100灵石，赠予访客2小时增益buff：悟道经验+10%、游商折扣+10%，鼓励玩家间友好互动。',
          '【驱逐封锁】驱逐后访客24小时内无法拜访和寻宝该洞府，是对不信任访客的防御性措施，不消耗灵石。',
          '【背叛惩罚】接待期间访客若寻宝该洞府（背叛信任），被发现率额外+50%（从30%→80%），形成"接待-背叛-驱逐"博弈循环。',
          '【幂等校验】已处理的访客记录不能再次操作（received/expelled/ignored 状态拒绝重复处理），只能处理 pending 状态记录。',
          '【权限校验】只能处理自己洞府的访客记录，无权处理他人洞府访客。',
          '【WebSocket 通知】接待/驱逐操作后通过 Socket.IO 实时通知访客（cave_visitor_received/cave_visitor_expelled 事件）。',
          '【配置中心化】cave_data.json social.visitor_reception 节点完整配置（开关/消耗/buff时长/buff加成/驱逐封锁时长/背叛发现率加成），全可热更新。',
          '【数据库】migration_0067 为 cave_visitors 表新增 reception_status/reception_at/reception_buff_until 列 + 2 个索引。',
          '【后端接口】新增 4 个 API：GET /visitors/reception + POST /visitors/:recordId/receive|expel|ignore。',
          '【前端 UI】CaveSocialPanel.vue 新增第 6 个"接待"Tab：待处理访客列表（接待/驱逐/忽略三按钮）+ 近期处理记录（状态徽章）+ 接待/驱逐确认弹窗。',
          '【前端 API】caveSocial.ts 新增 4 个 TypeScript 接口 + 4 个 API 方法。',
          '【OpenAPI】新增 4 个路径定义 + PendingVisitor schema，可导入 Apifox。',
          '【端到端测试】32/32 通过：配置加载/访客列表/接待/驱逐/忽略/幂等校验/权限校验/寻宝联动（驱逐封锁+背叛惩罚）。'
        ]
      },
      {
        title: '新增功能：聊天物品展示系统（多人社交互动深度·炫耀装备/分享收获）',
        type: 'feature',
        items: [
          '【多人社交】玩家可在聊天频道展示背包物品，其他玩家点击物品卡片查看详情，增加社交互动（炫耀装备、分享收获、促进交易需求）。',
          '【后端接口】新增 POST /api/chat/show-item，参数 item_key，校验玩家持有该物品（防伪造）→ 查询物品静态配置 → 创建 type=item_show 聊天消息（content 存储 JSON）→ Socket.IO 广播。',
          '【安全设计】必须校验玩家持有该物品，防止伪造展示不存在/未拥有的物品；content 中不存储 effect 具体数值，仅展示基础信息（名称/品质/类型/描述/售价/数量）。',
          '【前端 API】chat.ts 新增 showItem(itemKey) 方法 + ItemShowMessageContent/ShowItemResult 接口 + ChatMessageType 新增 item_show 类型。',
          '【聊天卡片】GlobalChat.vue 消息列表新增物品展示卡片（品质色边框 + 包裹图标 + 物品名 + 品质徽章 + 类型 + 数量），点击查看详情弹窗。',
          '【物品选择弹窗】输入框旁新增「展示物品」按钮（amber 主题，包裹图标），点击弹出背包物品网格（2 列布局，品质色边框），直接点击物品即可展示。',
          '【物品详情弹窗】点击聊天中物品卡片弹出详情（大图标 + 物品名 + 品质/类型徽章 + 描述 + 售价 + 持有数量），品质色边框匹配物品品质。',
          '【品质颜色映射】复用 InventoryPanel.vue 的 qualityColorMap（common 白/uncommon 绿/rare 蓝/epic 紫/legendary 橙），5 档品质差异化展示。',
          '【Socket 实时推送】物品展示消息通过 Socket.IO 实时广播，所有在线玩家即时看到；顶部通知文案「XXX 展示了【物品名】」。',
          '【历史记录】fetchMessages 支持 item_show 类型解析，加载历史物品展示消息；parseItemShowContent 安全解析 JSON。',
          '【OpenAPI】新增 POST /api/chat/show-item 路径定义（9 个 Chat 路径），含 201/400 响应示例，可导入 Apifox。'
        ]
      },
      {
        title: '优化：宗门加成前端展示补齐（信息透明度提升）',
        type: 'optimize',
        items: [
          '【信息透明】后端 SectService.getSectList/getMySect 早已返回 bonus 字段，但前端 SectPanel.vue 未渲染任何加成信息，玩家无法直观看到各宗门特色差异，本次补齐展示。',
          '【10 字段映射】新增 bonusLabels 中英文映射表：修为加成/采集加成/感知加成/突破加成/气运加成/攻击加成/魔道加成/魅惑加成/灵力加成/道心加成，覆盖 sect_data.json 全部 bonus 字段。',
          '【智能格式化】formatBonusValue 自动识别字段类型：*_multiplier 倍率类（1.1 → "+10%"）/ *_bonus 比例类（0.15 → "+15%"）/ mental_strength 比例类，统一百分比展示。',
          '【列表卡片】宗门列表卡片新增「宗门加成」展示区（flex-wrap 徽章布局），玩家选择宗门时可对比 6 大宗门加成特色（落云修为+采集 / 星宫感知+突破 / 天星气运+修为 / 凌霄突破+道心 / 阴罗攻击+魔道 / 合欢魅惑+灵力）。',
          '【我的宗门】我的宗门信息卡片新增「宗门加成」展示区（grid 2 列卡片布局，紫色主题），玩家入宗后可查看自身已激活的加成，附"入宗即享，永久生效"说明。',
          '【配置驱动】展示完全由后端 sect_data.json 驱动，不同宗门只配置 2 个 bonus 字段，前端自动过滤 undefined，新增宗门或调整加成无需改前端代码。',
          '【防御性设计】getBonusList 空对象/非对象/null 全部安全返回空数组，v-if 守卫避免空区块渲染；formatBonusValue 非数值/NaN 返回"—"。'
        ]
      },
      {
        title: '新增功能：神识对决 PvP 前端完整闭环（1v1 同时选择博弈·多人玩法深度）',
        type: 'feature',
        items: [
          '【前端补齐】后端 DivineDuelService 6 接口早已就绪，本次补齐前端 API + 完整面板，1v1 同时选择博弈 PvP 玩法正式可玩。',
          '【API 层】新建 divineSenseDuel.ts，6 个接口（challengeDuel/acceptDuel/performDuelAction/getActiveDuel/getDuelHistory/surrenderDuel）+ 完整 TypeScript 类型定义（含联合类型 ActionResult 区分"等待对方"与"已结算"两种状态）。',
          '【面板设计】DivineSenseDuelPanel.vue 4 Tab：当前对决（双方信息+护盾+行动按钮+投降）/发起挑战（目标ID+赌注类型+赌注数量）/对决历史（分页列表+胜负徽章）/玩法说明（行动矩阵+赌注+超时+策略提示）。',
          '【4 个 Modal】挑战确认 / 行动确认（凝神/固元效果说明）/ 回合结算（双方行动+护盾变化+对局结果）/ 投降确认，全部自定义组件，禁用浏览器原生弹窗。',
          '【自动刷新】进行中对决每 10 秒自动刷新状态，避免错过对手行动；WebSocket 实时推送回合结算结果。',
          '【Bug 修复】DivineDuelService.getActiveDuel/getHistory 中 created_at 字段访问 Bug：模型使用 underscored:true，时间戳属性应为驼峰 createdAt 而非下划线 created_at，修复后历史记录时间正常返回。',
          '【GameLayout 接入】import + ref + template + actionId handler 四处注册 + ActionBar 新增「神识对决」按钮（purple 主题，时钟+护盾图标）。',
          '94 项测试全部通过：登录/配置完整性/数据库表结构/Service 单元/当前对决接口/历史记录接口/参数校验（8 项）/业务校验/路由验证/前端文件验证（API+面板+GameLayout+ActionBar）/OpenAPI 文档。'
        ]
      },
      {
        title: '新增功能：器灵系统完整闭环（法宝深线第五条/玩法文档第7节）',
        type: 'feature',
        items: [
          '【器灵系统】法宝唤醒器灵后获得独立养成维度，4 种类型差异化设计：攻灵型（攻击+暴击）/防灵型（防御+吸血）/辅灵型（暴击闪避+净化）/平灵型（均衡+全属性）。',
          '【多维度养成】等级(1-10)/经验/亲密度(0-100)/力量值(0-1000)，各有独立 CD 冷却：抚摸1小时/温养2小时/护主30分/催发1小时/试炼每日3次。',
          '【8大子功能】唤醒器灵/我的器灵/器灵详情/器灵试炼/器灵护主/催发器灵/抚摸法宝/温养器灵 + 试炼排行榜（全服竞争维度）。',
          '【战斗系统集成】getCombatBonus 返回 { is_active, absolute, percent, effects, breakdown } 供 AttributeService 调用，与法宝深线前4条线归一化结构一致。',
          '【试炼评分】分数=(基础难度+等级×系数)×随机×力量倍率×亲密度倍率，5 档奖励匹配（D/C/B/A/S），力量值/灵石/经验多维度奖励。',
          '【配置驱动】artifact_spirit_data.json 全可变参数集中配置：启用开关/解锁境界/4 种类型基础加成/唤醒成本与成功率/成长曲线/试炼奖励/护主与催发 CD/排行奖励。',
          '【新增物品】item_data.json 新增 soul_stone（器灵魂石）作为唤醒必备材料，epic 品质，价格 10000 灵石。',
          '【前端面板】ArtifactSpiritPanel.vue 4 Tab 设计：我的器灵（卡片+6 操作按钮）/唤醒器灵（装备网格+4 类型差异化配色+命名）/试炼榜（分页+我的排名）/器灵图鉴（4 种类型说明+养成路径）。',
          '【3 个弹窗】详情弹窗（完整属性+冷却时间）/结果弹窗（操作反馈）/二次确认弹窗（高风险操作），全部使用自定义组件，禁用浏览器原生弹窗。',
          '【BigInt 安全】safeBigInt 工具函数处理 BIGINT 字段（trial_total_score/spirit_stones），避免精度丢失。',
          '【幂等迁移】migration_0065 创建 player_artifact_spirits 表（25+ 字段）+ 唯一索引 uk_player_equipment + 4 个辅助索引。',
          '【OpenAPI】9 个路径定义全部补齐 + 器灵系统 tag 注册，可导入 Apifox 等工具。',
          '【错误码扩展】ErrorCodes 新增 9 个细分业务错误码（FEATURE_DISABLED/REALM_NOT_ENOUGH/EQUIPMENT_BROKEN/ALREADY_EXISTS/LIMIT_EXCEEDED/CONDITION_NOT_MET/COOLDOWN/INSUFFICIENT_RESOURCES/PLAYER_DEAD）。',
          '【测试健壮性】唤醒重试逻辑（80% 成功率最多 3 次重试，每次 SQL 补充资源）+ 全部失败 SQL 直建器灵记录保证后续功能测试可执行。',
          '112 项测试全部通过：登录/配置完整性/数据库表结构/模型验证/列表接口/试炼榜接口/参数校验/唤醒重试/详情/抚摸/温养/护主/催发/试炼/Service 单元/路由验证/OpenAPI 文档。'
        ]
      },
      {
        title: '新增功能：PVP 战斗中使用丹药（多人战斗策略深度）',
        type: 'feature',
        items: [
          '【战斗丹药】PVP 斗法中新增「丹药」按钮，玩家可在战斗回合使用回春丹/小还丹/大还丹恢复气血，或凝气丹/聚灵丹恢复灵力，增加战斗策略博弈深度。',
          '【使用限制】每场战斗最多使用 3 次丹药，每回合最多 1 次，使用丹药消耗一个回合（不造成伤害），玩家需在"攻击/技能/防御/丹药"间权衡。',
          '【配置驱动】game_balance.json pvp.battle_items 配置段：enabled/max_uses_per_battle/allowed_subtypes 全部可热更新。',
          '【物品标记】item_data.json 为回春丹/小还丹/大还丹/凝气丹/聚灵丹添加 usable_in_battle: true 标记，仅 healing/mana 子类型可在战斗中使用。',
          'PvpService.executeAction 新增 item action：参数校验→配置校验→次数校验→物品配置查找→持有校验→扣除物品→恢复HP/MP→战斗日志记录。',
          'PvpService.getBattleItems 新增方法：查询玩家背包中可战斗使用的消耗品列表 + 本场剩余使用次数。',
          '新增 GET /api/pvp/battle-items 接口，POST /api/pvp/action action 参数新增 item 类型。',
          'PvpPanel.vue 新增丹药按钮（amber 主题）+ 丹药选择弹窗（物品列表/效果展示/持有数量/剩余次数），战斗日志支持展示丹药使用记录。',
          '27 项测试全部通过：登录/battle-items接口/参数校验/业务校验/配置完整性/物品标记/OpenAPI文档。'
        ]
      },
      {
        title: '新增功能：洞府拜访奇遇系统（多人社交探索深度）',
        type: 'feature',
        items: [
          '【洞府奇遇】拜访他人洞府时按 40% 概率触发随机奇遇，增加多人社交探索的惊喜感和互动价值。',
          '【五种奇遇】发现遗落丹药(物品)/灵脉残留(经验)/偶遇洞府灵兽(灵石)/触发洞府机关(陷阱：损血+获灵石)/空手而归，按权重 25:25:15:15:15 随机选择。',
          '【灵脉加成】目标洞府灵脉等级影响奖励倍率（1 + 灵脉等级 × 0.1），高灵脉洞府更值得拜访，创造玩家间互动价值。',
          '【每日限制】每日最多触发 5 次奇遇（独立于每日拜访次数），通过 encounter_type IS NOT NULL 统计当日奇遇次数。',
          '【事务原子性】奇遇奖励发放与访客记录更新在同一事务内提交，确保数据一致性；使用行级锁防止并发修改。',
          '【BigInt 安全】灵石/经验使用 BigInt 运算避免精度丢失，陷阱类型 HP 损失按百分比计算且不低于 1。',
          'CaveSocialService 新增 getEncounterConfig() + _triggerVisitEncounter() 方法，visitCave() 集成奇遇触发逻辑。',
          'cave_data.json 新增 visit_encounters 配置段（enabled/trigger_chance/daily_encounter_limit/encounters 数组），全可热更新。',
          'migration_0064 为 cave_visitors 表新增 encounter_type + encounter_reward 列 + idx_encounter_type 索引。',
          'CaveSocialPanel.vue 新增奇遇结果弹窗：展示奇遇名称/描述/奖励详情/今日次数，前端零业务逻辑。',
          'caveSocial.ts 新增 VisitEncounter/VisitEncounterRewards 类型定义，VisitCaveResult 完全重写匹配后端结构。',
          '31 项测试全部通过：登录/配置完整性/数据库迁移/模型验证/拜访接口/奇遇触发概率/数据库记录/OpenAPI文档。'
        ]
      },
      {
        title: '新增功能：封神台前端面板完整闭环（PVP 镜像排名竞技场）',
        type: 'feature',
        items: [
          '【封神台面板】新增 FengshenPanel.vue 完整前端面板，3 Tab 设计：排行榜/我的封神/赛季信息，紫金双色系彰显竞技荣耀感。',
          '【排行榜 Tab】分页展示排名列表，含排名徽章（金/银/铜）、昵称、境界、积分、胜率、胜负记录，仅可挑战排名比自己高 1~5 名的玩家。',
          '【我的封神 Tab】个人信息卡（排名/积分/胜率/赛季/累计胜负/今日剩余）+ 防守阵容展示（属性快照 ATK/DEF/速度/HP/境界）+ 一键设置/刷新防守阵容。',
          '【赛季信息 Tab】赛季时间（当前届/开始/结束/剩余天数）+ 赛季奖励规则（Top 1/2/3 名荣誉和灵石奖励展示）。',
          '【挑战流程】二次确认弹窗 → 调用接口 → 战斗结果弹窗（胜负/战力对比/积分变化/新排名/剩余次数）→ 自动刷新排行榜和个人信息。',
          'fengshen.ts API 层完整定义 6 个接口 + 10+ TypeScript 类型（FengshenRankingEntry/MyFengshenInfo/DefenseSnapshot/ChallengeResult/SeasonInfo 等）。',
          'GameLayout.vue 注册面板 + ActionBar.vue 新增「封神」按钮（purple 主题，奖杯图标）。',
          '后端 FengshenService 7 方法完整实现：getRanking/setDefense/challengeRank/getMyRanking/getDefense/getSeasonInfo/settleSeason，含事务+行级锁+幻世轮悟印集成+pvp_mode校验。',
          '87 项测试全部通过：登录/配置完整性/数据库表结构/模型验证/6 接口全链路/参数校验/未授权访问/OpenAPI文档。'
        ]
      },
      {
        title: '修复：寿命/死亡/轮回系统验证 + 奖励显示修复 + 配置补充',
        type: 'fix',
        items: [
          '【寿命系统验证】用户报告"玩家年龄/修为/死亡界面变化/事件触发需检查测试"，经端到端测试验证（39/39 通过）：年龄定时增长正常（每10分钟+0.027年）、寿元耗尽正确触发死亡（is_dead=true/death_reason=寿元耗尽/death_time设置）、修为扣除10%正确、HP归零、lifespan定格在max。',
          '【死亡通知验证】WebSocket 推送 player_death 事件正常：notifyPlayerUpdate 推送给玩家本人（触发前端 DeathOverlay 显示）、broadcastNotification 全局广播"道友陨落"通知，payload 含 player_id/reason/exp_loss。',
          '【轮回重生验证】/api/player/reincarnate 接口正确重置所有字段：is_dead=false/death_reason=null/death_time=null/realm=凡人/realm_rank=0/lifespan重置为16/60/修为保留10%/HP=100/闭关悟道瓶颈状态清空，并推送 player_reincarnate 事件。',
          '【B46 修复】ExplorePanel.vue 历练"预计获得"显示基础奖励未含境界倍率：化神期玩家（倍率3.2x）看到"预计获得10修为"实际获得32修为。新增 realmMultiplier+estimatedExp 计算属性，预估=基础×境界倍率，与后端 grantRewards 一致。',
          '【灵石显示修复】PlayerStatus.vue 灵石显示未使用 formatNumber：BigInt 字符串直接插值无千分位分隔，高境界玩家灵石数大时不便阅读。改为 formatNumber 处理。',
          '【配置补充】role_init.json 新增 reincarnateExpKeepRate:0.1 显式声明：原路由用 ?? 0.1 兜底但配置项未声明，违反"可变参数抽至配置文件"规则，现显式声明。',
          '【DeathOverlay 确认】GameLayout.vue v-if="playerStore.player?.is_dead" 正确挂载，死亡时全屏覆盖显示死亡原因/时间/剩余修为，提供轮回重生和退出登录按钮，轮回成功后 is_dead=false 自动隐藏。'
        ]
      }
    ]
  },
  {
    version: 'v0.3.9_BETA',
    date: '2026-07-22',
    sections: [
      {
        title: '新增功能：聊天红包系统（多人社交玩法）',
        type: 'feature',
        items: [
          '【红包玩法】玩家可在全局聊天频道发送红包，其他在线玩家可领取，增加多人社交互动深度。',
          '【拼手气红包】使用二倍均值法随机分配金额，手气最佳者获得最多，最后一个领取者触发手气最佳标记（👑）。',
          '【普通均分红包】每个领取者获得相同金额（整除，余数给前几个），适合公平分配场景。',
          '【过期退款】红包 24 小时过期，未领取的剩余金额自动退还发送者（StateCleanerService 每 5 秒扫描清理）。',
          '【防重复领取】唯一索引 (red_packet_id, receiver_id) + 业务校验双重保险，同一玩家对同一红包只能领取一次。',
          '【每日限额】每玩家每日最多发送 10 个红包，防止灵石洗钱或刷屏。',
          'RedPacketService 完整实现：sendRedPacket/claimRedPacket/getRedPacketDetail/getActiveRedPackets/cleanExpiredRedPackets。',
          '新增 4 个 API 接口：POST /api/chat/red-packet/send、/:id/claim、GET /:id、/active。',
          'GlobalChat.vue 红包交互：红包卡片展示 + 发红包弹窗（金额/个数/类型/留言）+ 红包详情弹窗（领取记录列表 + 手气最佳标记）。',
          'chat.ts 新增红包类型定义 + 4 个红包 API 方法，Socket.IO 广播红包消息实时推送。',
          'migration_0063 创建 chat_red_packets + chat_red_packet_claims 表 + chats.type ENUM 扩展 red_packet 类型。',
          '51 项接口测试全部通过：登录/参数校验/发送/查询/领取/活跃列表/OpenAPI/配置完整性/迁移脚本/状态注册。'
        ]
      }
    ]
  },
  {
    version: 'v0.3.8_BETA',
    date: '2026-07-22',
    sections: [
      {
        title: '新增功能：悬赏系统深度加强（保护期 + 反悬赏）',
        type: 'feature',
        items: [
          '【悬赏保护期】被悬赏者完成悬赏战斗后获得 30 分钟保护期，保护期内不可被再次悬赏，防止恶意连续悬赏同一玩家。',
          '【反悬赏机制】被悬赏者可花费灵石主动反击，对悬赏自己的人发起反向悬赏，增加 PVP 社交博弈深度。',
          '反悬赏金额 = 原悬赏金额 × 1.2 倍率，反悬赏链深度上限 3 次（通过 reason 前缀 [反悬赏] 计数），防止无限连锁。',
          'BountyService 新增 counterBounty 方法 + publishBounty 保护期校验 + getMyBounties 新增 targeting_me 分类。',
          '新增 POST /api/bounty/:bountyId/counter 接口，前端 BountyPanel.vue 新增"针对我的悬赏"子分类 + 反悬赏按钮 + 确认弹窗。',
          'game_balance.json pvp_extended.bounty 新增 protection_period_minutes + counter_bounty 配置段，支持热更新。',
          '23 项接口测试全部通过：登录/查询/参数校验/权限校验/OpenAPI文档/配置完整性。'
        ]
      },
      {
        title: '新增功能：五行相克 PVP 前端展示',
        type: 'feature',
        items: [
          '【PvpPanel 五行展示】战斗区新增五行相克展示卡：双方灵根属性徽章（金⚔️/木🌿/水💧/火🔥/土⛰️）+ 克制关系 + 伤害倍率 + 优势提示文案。',
          '战斗日志新增五行克制标签：行动方克制显示绿色标签，被克显示红色标签，直观展示每回合克制效果。',
          '新增 7 个五行辅助方法（elementIcon/elementName/elementBadgeClass/elementBorderColor/elementAdvantageTextClass 等）。',
          'pvp.ts 新增 ElementType/PvpElementInfo/PvpBattleLogElement 类型定义，PvpBattleInfo 新增 element_info 字段，PvpBattleLogEntry 新增 element 字段。'
        ]
      },
      {
        title: '关键Bug修复',
        type: 'fix',
        items: [
          '【战斗掉落物品数量丢失·关键修复】CombatService 使用 Item.upsert 入包会替换已有数量而非累加（如已有5个+掉落3个→变为3个而非8个），改为 InventoryService.addItem 正确累加。',
          '【采集产物数量丢失·关键修复】GatheringService 同样使用 Item.upsert 导致采集产物数量被替换，已改为 InventoryService.addItem。'
        ]
      }
    ]
  },
  {
    version: 'v0.3.7_BETA',
    date: '2026-07-22',
    sections: [
      {
        title: '关键Bug修复',
        type: 'fix',
        items: [
          '【战斗掉落物品数量丢失·关键修复】CombatService 使用 Item.upsert 入包会替换已有数量而非累加（如已有5个+掉落3个→变为3个而非8个），改为 InventoryService.addItem 正确累加。',
          '【采集产物数量丢失·关键修复】GatheringService 同样使用 Item.upsert 导致采集产物数量被替换，已改为 InventoryService.addItem。',
          '此前悬赏系统结算链路断裂、悬赏/洞府社交前端缺失等问题在 v0.3.6_BETA 中已修复。'
        ]
      },
      {
        title: '新增功能：五行相克 PVP 战斗系统',
        type: 'feature',
        items: [
          '【PVP 五行相克】基于灵根属性（金/木/水/火/土）计算克制伤害倍率，增加 PVP 战斗策略深度。',
          '克制关系：金克木、木克土、土克水、水克火、火克金。克制方伤害 ×1.2，被克方 ×0.8，无克制 ×1.0。',
          'PvpService 新增 _getPlayerElement（从灵根 type 提取五行属性）+ _calculateElementMultiplier（计算克制倍率）两个方法。',
          'executeAction 伤害计算集成五行倍率：attack/skill 伤害均乘以 elementMultiplier。',
          '战斗日志新增 element 字段（attacker_element/defender_element/multiplier/advantage/name），供前端展示"金克木"等克制效果。',
          'getStatus 返回 element_info 字段（my_element/opponent_element/matchup/advantage/multiplier），前端可在战斗前展示双方灵根克制关系。',
          'game_balance.json pvp 段新增 five_elements 配置（advantage_multiplier/disadvantage_multiplier/overcomes/element_names），支持热更新。',
          '9 项单元测试全部通过：金克木/木被金克/火克金/水克火/同属性/无属性/土克水/木克土 等场景验证正确。'
        ]
      }
    ]
  },
  {
    version: 'v0.3.6_BETA',
    date: '2026-07-22',
    sections: [
      {
        title: '关键Bug修复',
        type: 'fix',
        items: [
          '【悬赏系统结算链路断裂·关键修复】BountyService.settlePendingBountyBattles/cleanExpiredBounties 从未被任何路由/调度器调用，导致 accepted 状态悬赏死锁、过期悬赏永不退款。',
          '修复方案：创建 bounty.js 状态注册文件接入 StateCleanerService 定期调度（5s 间隔），执行两阶段清理（扫描结算已结束战斗的悬赏 + 清理过期悬赏退款）。',
          'PvpService 三处战斗结束路径全部添加 bounty 结算同步钩子：executeAction（正常结束）+ flee（逃跑判负）+ cleanExpiredBattles（超时判平），均在 t.commit() 之后调用避免嵌套事务。',
          'game_balance.json state_cleaner 段新增 bounty 子配置（enable/auto_settle/interval_ms=5000）。'
        ]
      },
      {
        title: '新增功能',
        type: 'feature',
        items: [
          '【悬赏追杀·前端面板】新增 BountyPanel.vue（3 Tab：悬赏榜单/我的悬赏/发布悬赏），支持状态过滤、分页、接取/取消二次确认。',
          '【洞府社交·前端面板】新增 CaveSocialPanel.vue（4 Tab：留言板/访客录/景观/游商），支持留言/拜访/布置景观/购买商品。',
          'ActionBar 新增「悬赏」「社交」两个入口按钮。'
        ]
      }
    ]
  },
  {
    version: 'v0.3.5_BETA',
    date: '2026-07-22',
    sections: [
      {
        title: '新增功能',
        type: 'feature',
        items: [
          '【法宝深线战力加成·属性系统集成】三条法宝深线战力加成统一归一化并接入 AttributeService：血魔剑百分比加成（atk/def+暴击/吸血/反噬特效）+ 虚天鼎绝对值加成（atk/def+化极倍率+反噬）+ 大五行幻世轮百分比加成（atk/def/hp_max/speed+相位×阶数倍率），掌天瓶为纯辅助法宝不参与聚合。',
          '新增 getAllArtifactDeepLineCombatBonuses 方法：并行查询三条线战力加成，归一化为 { is_active, absolute, percent, effects, breakdown } 统一结构，供 AttributeService.calculateFullAttributesAsync 调用，所有调用该方法的战斗/接口自动生效。',
          '新增 safeAddInsightExp 方法：战斗结算流程的安全封装，内部自带 try/catch + 独立事务，未装备幻世轮时静默返回，不影响主战斗流程。',
          '【悟印被动积累·13 个战斗 Service 全量集成】大五行幻世轮的 addInsightExp 正式接入全部战斗结算流程，被动战斗驱动成长机制全面生效。'
        ]
      },
      {
        title: '战斗系统集成明细',
        type: 'optimize',
        items: [
          'PVE 战斗（3 处）：CombatService attack/monsterTurn/flee — 战斗胜负/逃跑均积累悟印。',
          '副本/试刀（4 处）：DungeonService 通关 / SparringService 切磋木人 / WorldBossService 终结者击杀 / BeastInvasionService 终结者击杀 — 仅对终结者调用避免多参与者耗尽每日上限。',
          'PVP 双玩家（3 文件 12 处）：PvpService executeAction+flee（双方各调用，flee 补查玩家对象）/ DuelService executeDuelAction（双方）/ DivineDuelService action+surrender+checkTimeouts 三个结算入口（duel_finished 守卫，省略 opponent_realm_rank 回退自身 rank）。',
          '排名/多人战斗（4 文件 10 处）：FengshenService 封神台挑战（双方）/ SpiritBeastPvpService 灵兽PVP 非友谊赛+友谊赛（双方，切磋调性）/ SectWarService 宗门战 surrender+advanceWarState（遍历 participants，settled 守卫）/ MultiDungeonService 多人副本普通通关+黄龙山决战（遍历在场 members）。',
          'BountyService 被 PvpService 覆盖无需单独接入。所有调用严格在 t.commit() 之后执行，避免嵌套事务/锁竞争。'
        ]
      },
      {
        title: '属性计算集成明细',
        type: 'optimize',
        items: [
          'calculateFullAttributes 新增步骤8：法宝深线绝对值加成（addAttr 叠加到 final）+ 百分比加成（基于 final 乘算），breakdown.artifact_deep_line 记录实际叠加值，info.artifact_deep_line 记录战斗特效供战斗系统读取。',
          'calculateFullAttributesAsync 并行获取装备/灵兽/法宝深线三套加成，通过 player._artifactDeepLineBonus 传入同步方法，计算后清理临时字段。'
        ]
      },
      {
        title: '功能对比清单研读',
        type: 'other',
        items: [
          '完成功能对比清单全量扫描（474 行），梳理出未实现/部分实现/待处理功能清单。',
          '❌未实现（5 项）：问道 / 法相天地 / 探寻裂缝 / 天机回溯（第3节境界与突破）+ 请侍妾护法（第12节社交与道侣）。',
          '⚠️部分实现（13 项）：切换角色UI / 宗门增益 / 后期系统前端 / 虚弱残魂心魔 / 布置景观 / 查看货品 / 器灵试炼 / 封神台 / 侍妾三件套 / 元神调度UI / 修理一键修理。',
          '用户报告的 Bug（深度闭关境界锁死 / 奖励数值显示 / 玩家年龄修为死亡界面变化）在文档中均已标记为已修复。',
          '多人玩法深度评估：斗法/悬赏/聊天/洞府拜访四项互动深度评为"浅"，后续可加强耐玩性。'
        ]
      },
      {
        title: '验证',
        type: 'other',
        items: [
          '13 个 Service 共 30 处 safeAddInsightExp 调用全部通过 rg 验证，分布正确。',
          '14 个修改文件全部通过 node -c 语法检查。',
          '服务重启成功，所有调度器（StateCleaner 5s / WorldBoss / BeastInvasion / SectWar / Sparring / 神识对决 / 股市）正常运行，登录接口 + GET /api/player/me 正常响应。'
        ]
      }
    ]
  },
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
        title: '新增功能：洞天寻宝系统（多人交互核心·资源真实转移+社交博弈）',
        type: 'feature',
        items: [
          '【多人交互核心】拜访道友洞府后可主动探索地块寻宝（1-9 号地块九宫格选择），寻宝成功从洞府主人灵石中"借取"5-15%（真实资源转移），失败触发陷阱（HP损失5-15%+灵石损失50-200）或遭遇护阵（灵石损失20-80）。',
          '【社交博弈】寻宝失败时 30% 概率被洞府主人发现，主人收到 Socket.IO 实时通知，增加社交互动与报复博弈。',
          '【成功率公式】基础 35% + 境界差×3% - 护山大阵等级×5%，限制在 5%-85%。鼓励玩家提升境界差优势、布置大阵防御。',
          '【冷却限制】每日限 5 次，同一洞府 24 小时冷却，寻宝费 100 灵石/次。使用事务+行级锁+BigInt 安全计算保证并发安全。',
          '【后端接口】新增 POST /api/cave-social/treasure + GET /api/cave-social/treasure/logs（支持 hunter/owner 双视角查询）。',
          '【数据库】新增 cave_treasure_logs 表（3 索引：每日次数/同洞府冷却/被寻宝记录），迁移脚本 migration_0066 已执行。',
          '【前端 UI】CaveSocialPanel.vue 新增第 5 个"寻宝"Tab：地块九宫格选择 + 寻宝结果弹窗（宝物/陷阱/遭遇/空手四色展示）+ 寻宝日志双视角切换（我的寻宝记录/洞府被寻宝记录）。',
          '【配置中心化】cave_data.json social.treasure_hunt 节点完整配置（开关/费用/次数/冷却/成功率/结果权重/奖励范围/发现惩罚），所有数值可热更新。',
          '【端到端测试】28/28 通过（参数校验4 + 寻宝执行7 + 资源转移验证 + 日志查询6 + 冷却校验 + 清理还原）。'
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
