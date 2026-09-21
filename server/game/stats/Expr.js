/**
 * 受限算术表达式求值器（词法 + Pratt 解析，不使用 eval/new Function）
 *
 * 用途：让"属性公式"和"伤害公式"成为数据（写在 stat/combat 配置里），
 * 而不是散落在各 Service 里的 if-else。新增一个属性参与计算时只改配置。
 *
 * 语法：十进制数字、标识符、+ - * / % ^、括号、一元正负、逗号分隔实参、
 *      白名单函数 floor/ceil/round/abs/min/max/clamp/pow/sqrt。
 * 约束：标识符只能是上下文里已登记的数值键，未登记即报错（拒绝静默取 0）。
 */
'use strict';

const FUNCTIONS = {
    floor: (a) => Math.floor(a),
    ceil: (a) => Math.ceil(a),
    round: (a) => Math.round(a),
    abs: (a) => Math.abs(a),
    sqrt: (a) => Math.sqrt(a),
    min: (...args) => Math.min(...args),
    max: (...args) => Math.max(...args),
    clamp: (value, lo, hi) => Math.min(Math.max(value, lo), hi),
    pow: (base, exponent) => Math.pow(base, exponent)
};

/** 各运算符右结合优先级 */
const BINARY_PRECEDENCE = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3 };

function tokenize(input) {
    const tokens = [];
    let i = 0;
    while (i < input.length) {
        const ch = input[i];

        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }

        if (ch >= '0' && ch <= '9' || (ch === '.' && input[i + 1] >= '0' && input[i + 1] <= '9')) {
            let num = '';
            while (i < input.length && ((input[i] >= '0' && input[i] <= '9') || input[i] === '.')) {
                num += input[i++];
            }
            const value = Number(num);
            if (!Number.isFinite(value)) throw new Error(`表达式数字非法: ${num} <- ${input}`);
            tokens.push({ type: 'number', value });
            continue;
        }

        if (/[A-Za-z_]/.test(ch)) {
            let name = '';
            while (i < input.length && /[A-Za-z0-9_]/.test(input[i])) name += input[i++];
            tokens.push({ type: 'ident', value: name });
            continue;
        }

        if (BINARY_PRECEDENCE[ch] || ch === '(' || ch === ')' || ch === ',') {
            tokens.push({ type: ch });
            i++;
            continue;
        }

        throw new Error(`表达式含不支持的字符 "${ch}" <- ${input}`);
    }
    tokens.push({ type: 'end' });
    return tokens;
}

/**
 * 求值核心：接收已分词的 token 流，避免热路径重复分词。
 * @param {Array} tokens tokenize() 的结果
 * @param {string} source 原始表达式，仅用于报错回显
 * @param {Object<string,number>} context 标识符 → 数值
 * @param {string} [label] 出错时标注来源（如属性 key）
 */
function runTokens(tokens, source, context = {}, label = '') {
    let pos = 0;
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];
    const where = () => `${source}${label ? ` (${label})` : ''}`;

    function parseExpr(minPrecedence) {
        let left = parseUnary();
        while (BINARY_PRECEDENCE[peek().type] >= minPrecedence) {
            const op = next().type;
            // ^ 右结合：右侧用同优先级；其余左结合用 priority+1
            const right = parseExpr(op === '^' ? BINARY_PRECEDENCE[op] : BINARY_PRECEDENCE[op] + 1);
            left = applyBinary(op, left, right);
        }
        return left;
    }

    function parseUnary() {
        const token = peek();
        if (token.type === '-') { next(); return -parseExpr(2); }
        if (token.type === '+') { next(); return parseExpr(2); }
        return parsePrimary();
    }

    function parsePrimary() {
        const token = next();

        if (token.type === 'number') return token.value;

        if (token.type === '(') {
            const value = parseExpr(1);
            if (next().type !== ')') throw new Error(`缺少右括号 <- ${where()}`);
            return value;
        }

        if (token.type === 'ident') {
            const name = token.value;
            if (peek().type === '(') {
                const fn = FUNCTIONS[name];
                if (!fn) throw new Error(`未白名单的函数 "${name}" <- ${where()}`);
                next();
                const args = [];
                if (peek().type !== ')') {
                    do {
                        args.push(parseExpr(1));
                        const separator = next();
                        if (separator.type === ')') break;
                        if (separator.type !== ',') throw new Error(`函数实参分隔符错误 <- ${where()}`);
                    } while (true);
                }
                const result = fn(...args);
                if (!Number.isFinite(result)) throw new Error(`函数 ${name}() 结果非有限数 <- ${where()}`);
                return result;
            }

            if (!Object.prototype.hasOwnProperty.call(context, name)) {
                throw new Error(`未知标识符 "${name}" <- ${where()}`);
            }
            const value = Number(context[name]);
            if (!Number.isFinite(value)) throw new Error(`标识符 "${name}" 非有限数 <- ${where()}`);
            return value;
        }

        throw new Error(`表达式语法错误，意外的 ${token.type} <- ${where()}`);
    }

    function applyBinary(op, left, right) {
        switch (op) {
            case '+': return left + right;
            case '-': return left - right;
            case '*': return left * right;
            case '/': return right === 0 ? 0 : left / right;
            case '%': return right === 0 ? 0 : left % right;
            case '^': return Math.pow(left, right);
            default: throw new Error(`未知运算符 ${op}`);
        }
    }

    const result = parseExpr(1);
    if (peek().type !== 'end') {
        throw new Error(`表达式存在多余内容 "${peek().type}" <- ${where()}`);
    }
    if (!Number.isFinite(result)) {
        throw new Error(`表达式结果非有限数 <- ${where()}`);
    }
    return result;
}

/**
 * 解析并求值。
 * @param {string} input 表达式
 * @param {Object<string,number>} context 标识符 → 数值
 * @param {string} [label] 出错时标注来源（如属性 key）
 */
function evaluate(input, context = {}, label = '') {
    if (typeof input !== 'string' || input.trim() === '') {
        throw new Error(`表达式为空${label ? ` (${label})` : ''}`);
    }
    return runTokens(tokenize(input), input, context, label);
}

/** 编译一次、多次求值：战斗回合等热路径避免重复分词 */
function compile(input, label = '') {
    if (typeof input !== 'string' || input.trim() === '') {
        throw new Error(`表达式为空${label ? ` (${label})` : ''}`);
    }
    const tokens = tokenize(input);
    return (context = {}) => runTokens(tokens, input, context, label);
}

/** 取出表达式引用的全部标识符，用于装配期校验（配置写错在启动时就报） */
function referencedIdents(input) {
    const names = new Set();
    if (typeof input !== 'string' || input.trim() === '') return names;
    const tokens = tokenize(input);
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.type !== 'ident') continue;
        if (tokens[i + 1] && tokens[i + 1].type === '(') continue; // 函数名
        names.add(token.value);
    }
    return names;
}

module.exports = { evaluate, compile, referencedIdents, tokenize, FUNCTIONS };
