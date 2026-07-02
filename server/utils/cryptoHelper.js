/**
 * 加密工具模块
 * 用于敏感配置项（如 AI API Key）的对称加密与解密
 *
 * 算法：AES-256-CBC
 * 密钥来源：环境变量 AI_CONFIG_ENCRYPTION_KEY（32 字节 hex 字符串）
 * 密文格式：base64(iv + ciphertext)，便于存储在 TEXT 字段
 *
 * 安全设计：
 *   1. 密钥仅在服务端 .env 中，不硬编码、不下发前端
 *   2. 每次加密生成随机 IV，相同明文密文不同，防重放攻击
 *   3. 密文携带 IV，解密时无需额外存储 IV
 *   4. 提供 mask() 方法用于 API Key 脱敏展示（仅显示后4位）
 */

const crypto = require('crypto');

// 加密算法与密钥长度配置
const ALGORITHM = 'aes-256-cbc';
const KEY_LENGTH_BYTES = 32;   // AES-256 需要 32 字节密钥
const IV_LENGTH_BYTES = 16;    // CBC 模式 IV 长度固定 16 字节

/**
 * 从环境变量读取加密密钥并派生为 32 字节 Buffer
 * 兼容两种输入格式：
 *   - 64 位 hex 字符串（推荐，强度足够）
 *   - 任意长度字符串（使用 sha256 派生为 32 字节，向后兼容）
 * @returns {Buffer} 32 字节密钥 Buffer
 * @throws {Error} 未配置 AI_CONFIG_ENCRYPTION_KEY 时抛错
 */
function getEncryptionKey() {
    const rawKey = process.env.AI_CONFIG_ENCRYPTION_KEY;
    if (!rawKey) {
        throw new Error('未配置 AI_CONFIG_ENCRYPTION_KEY 环境变量，无法加解密 AI 配置');
    }

    // 若为合法的 64 位 hex 字符串，直接转换为 Buffer
    if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
        return Buffer.from(rawKey, 'hex');
    }

    // 否则使用 sha256 派生为 32 字节密钥（兼容任意长度字符串输入）
    return crypto.createHash('sha256').update(rawKey).digest();
}

/**
 * 加密明文为密文字符串
 * @param {string} plaintext - 待加密的明文（如 API Key）
 * @returns {string} base64 编码的密文（格式：iv + ciphertext）
 */
function encrypt(plaintext) {
    if (plaintext === null || plaintext === undefined || plaintext === '') {
        return '';
    }

    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH_BYTES);   // 随机 IV，防重放
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(String(plaintext), 'utf8', 'hex');
    encrypted += cipher.final('hex');

    // 将 IV 拼接在密文前，便于解密时一次性取出
    const combined = Buffer.concat([iv, Buffer.from(encrypted, 'hex')]);
    return combined.toString('base64');
}

/**
 * 解密密文字符串为明文
 * @param {string} ciphertext - base64 编码的密文
 * @returns {string} 明文
 */
function decrypt(ciphertext) {
    if (!ciphertext) {
        return '';
    }

    try {
        const key = getEncryptionKey();
        const combined = Buffer.from(ciphertext, 'base64');

        // 前 16 字节为 IV，其余为密文
        const iv = combined.slice(0, IV_LENGTH_BYTES);
        const encryptedData = combined.slice(IV_LENGTH_BYTES);

        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        let decrypted = decipher.update(encryptedData.toString('hex'), 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    } catch (error) {
        console.error('[cryptoHelper] 解密失败:', error.message);
        throw new Error('解密失败，请检查 AI_CONFIG_ENCRYPTION_KEY 是否正确');
    }
}

/**
 * 对 API Key 进行脱敏处理，仅保留后 4 位
 * 用于向前端返回时隐藏完整 Key，避免泄露
 * @param {string} apiKey - 完整 API Key
 * @returns {string} 脱敏后的字符串，如 "****abcd"
 */
function mask(apiKey) {
    if (!apiKey) return '';
    const str = String(apiKey);
    if (str.length <= 4) {
        return '****';
    }
    return '****' + str.slice(-4);
}

module.exports = {
    encrypt,
    decrypt,
    mask
};
