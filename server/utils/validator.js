/**
 * 输入验证工具函数
 * 
 * 提供常用的参数验证方法，验证失败时抛出 AppError
 */
const { AppError, ErrorCodes } = require('../middleware/errorHandler');

const Validator = {
    /**
     * 验证正整数
     */
    isPositiveInteger(value, fieldName) {
        const num = Number(value);
        if (!Number.isInteger(num) || num <= 0) {
            throw new AppError(`${fieldName}必须是正整数`, 400, ErrorCodes.VALIDATION_ERROR);
        }
        return num;
    },

    /**
     * 验证非负整数（>= 0）
     */
    isNonNegativeInteger(value, fieldName) {
        const num = Number(value);
        if (!Number.isInteger(num) || num < 0) {
            throw new AppError(`${fieldName}必须是非负整数`, 400, ErrorCodes.VALIDATION_ERROR);
        }
        return num;
    },

    /**
     * 验证非空字符串
     */
    isNonEmptyString(value, fieldName) {
        if (typeof value !== 'string' || value.trim() === '') {
            throw new AppError(`${fieldName}不能为空`, 400, ErrorCodes.VALIDATION_ERROR);
        }
        return value.trim();
    },

    /**
     * 验证枚举值
     */
    isEnum(value, allowedValues, fieldName) {
        if (!allowedValues.includes(value)) {
            throw new AppError(
                `${fieldName}必须是以下值之一: ${allowedValues.join(', ')}`,
                400,
                ErrorCodes.VALIDATION_ERROR
            );
        }
        return value;
    },

    /**
     * 验证必填参数
     */
    isRequired(value, fieldName) {
        if (value === undefined || value === null || value === '') {
            throw new AppError(`${fieldName}不能为空`, 400, ErrorCodes.VALIDATION_ERROR);
        }
        return value;
    }
};

module.exports = Validator;
