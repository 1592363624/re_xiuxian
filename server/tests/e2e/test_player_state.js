/**
 * 检查玩家完整状态：年龄、修为、寿元、死亡状态等
 * 验证 /api/player/me 返回的所有关键字段
 */
'use strict';

const axios = require('axios');

const API_BASE = 'http://localhost:5000';

async function main() {
    console.log('========================================');
    console.log('玩家完整状态检查');
    console.log('========================================\n');

    // 1. 登录
    const loginResp = await axios.post(`${API_BASE}/api/auth/login`, {
        username: '1592363624',
        password: '1592363624'
    });
    const token = loginResp.data.token;
    const authHeaders = { Authorization: `Bearer ${token}` };
    console.log(`登录: realm=${loginResp.data.player.realm}\n`);

    // 2. 查询玩家完整信息
    console.log('[GET /api/player/me]');
    const meResp = await axios.get(`${API_BASE}/api/player/me`, { headers: authHeaders });
    const me = meResp.data.data || meResp.data;

    const fields = [
        'id', 'nickname', 'realm', 'realm_rank', 'role',
        'exp', 'age', 'age_max', 'lifespan_current', 'lifespan_max',
        'is_dead', 'death_reason', 'death_time',
        'hp_current', 'hp_max', 'mp_current', 'mp_max',
        'spirit_stones', 'is_secluded', 'seclusion_mode',
        'is_meditating', 'is_adventuring', 'is_moving',
        'bottleneck_state', 'bottleneck_progress',
        'divine_sense', 'divine_sense_max',
        'last_online', 'created_at'
    ];

    for (const f of fields) {
        const val = me[f];
        if (val !== undefined && val !== null) {
            console.log(`  ${f}: ${val}`);
        } else {
            console.log(`  ${f}: <未返回或为空>`);
        }
    }

    console.log('\n[关键状态分析]');

    // 年龄检查
    if (me.age !== undefined && me.age_max !== undefined) {
        const ageRatio = me.age / me.age_max;
        if (ageRatio > 0.9) {
            console.log(`  ⚠️ 年龄 ${me.age}/${me.age_max} 接近寿元上限，玩家即将面临寿命危机`);
        } else if (ageRatio > 0.7) {
            console.log(`  ⚠️ 年龄 ${me.age}/${me.age_max} 已过 70%，需注意寿命管理`);
        } else {
            console.log(`  ✅ 年龄 ${me.age}/${me.age_max} 正常`);
        }
    } else {
        console.log(`  ❌ age 或 age_max 字段缺失`);
    }

    // 寿元检查
    if (me.lifespan_current !== undefined && me.lifespan_max !== undefined) {
        const lifeRatio = Number(me.lifespan_current) / Number(me.lifespan_max);
        if (lifeRatio < 0.2) {
            console.log(`  ⚠️ 寿元 ${me.lifespan_current}/${me.lifespan_max} 已不足 20%，即将死亡`);
        } else if (lifeRatio < 0.5) {
            console.log(`  ⚠️ 寿元 ${me.lifespan_current}/${me.lifespan_max} 不足 50%，需尽快突破延长寿命`);
        } else {
            console.log(`  ✅ 寿元 ${me.lifespan_current}/${me.lifespan_max} 正常`);
        }
    } else {
        console.log(`  ❌ lifespan_current 或 lifespan_max 字段缺失`);
    }

    // 修为检查
    if (me.exp !== undefined) {
        console.log(`  ℹ️ 修为: ${me.exp}`);
    }

    // 死亡状态检查
    if (me.is_dead) {
        console.log(`  ⚠️ 玩家已死亡！death_reason=${me.death_reason}, death_time=${me.death_time}`);
        console.log(`     → 前端应显示 DeathOverlay，提供夺舍重生入口`);
    } else {
        console.log(`  ✅ 玩家存活`);
    }

    // HP/MP 检查
    if (me.hp_current !== undefined && me.hp_max !== undefined) {
        const hpRatio = Number(me.hp_current) / Number(me.hp_max);
        if (hpRatio < 0.3) {
            console.log(`  ⚠️ HP ${me.hp_current}/${me.hp_max} 不足 30%，需恢复`);
        } else {
            console.log(`  ✅ HP ${me.hp_current}/${me.hp_max} 正常`);
        }
    }

    if (me.mp_current !== undefined && me.mp_max !== undefined) {
        const mpRatio = Number(me.mp_current) / Number(me.mp_max);
        if (mpRatio < 0.3) {
            console.log(`  ⚠️ MP ${me.mp_current}/${me.mp_max} 不足 30%，需恢复`);
        } else {
            console.log(`  ✅ MP ${me.mp_current}/${me.mp_max} 正常`);
        }
    }

    process.exit(0);
}

main().catch(err => {
    console.error('异常:', err.response?.data || err.message);
    process.exit(1);
});
