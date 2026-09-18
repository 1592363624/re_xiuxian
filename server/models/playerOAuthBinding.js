/**
 * 第三方账号绑定模型
 *
 * 一个玩家账号在每个第三方平台下最多绑定一个身份（uk_oauth_provider_player），
 * 一个第三方身份也只能绑定一个账号（uk_oauth_provider_openid），双向唯一避免共号纠纷。
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PlayerOAuthBinding = sequelize.define('PlayerOAuthBinding', {
    id: {
        type: DataTypes.BIGINT,
        primaryKey: true,
        autoIncrement: true
    },
    provider: {
        type: DataTypes.STRING(20),
        allowNull: false,
        comment: '第三方平台标识：qq'
    },
    open_id: {
        type: DataTypes.STRING(64),
        allowNull: false,
        comment: '平台内用户唯一标识（QQ 互联 openid，按应用隔离）'
    },
    union_id: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: '同主体下跨应用统一标识，QQ 互联未开通该能力时为空'
    },
    player_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: '绑定的玩家ID'
    },
    nickname: {
        type: DataTypes.STRING(64),
        allowNull: true,
        comment: '绑定时拉取到的第三方昵称，仅用于后台展示，可能为空'
    },
    avatar_url: {
        type: DataTypes.STRING(255),
        allowNull: true,
        comment: '绑定时拉取到的第三方头像，仅用于展示，可能为空'
    },
    last_login_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '最近一次通过该第三方身份登录的时间'
    }
}, {
    tableName: 'player_oauth_bindings',
    timestamps: true,
    indexes: [
        { name: 'uk_oauth_provider_openid', unique: true, fields: ['provider', 'open_id'] },
        { name: 'uk_oauth_provider_player', unique: true, fields: ['provider', 'player_id'] }
    ]
});

module.exports = PlayerOAuthBinding;
