// 表單元件
// 通用表單控制元件：Input、Select、FormGroup

import type { FC, PropsWithChildren } from 'hono/jsx';

/** 表單群組屬性 */
export interface FormGroupProps {
  /** 欄位標籤 */
  label: string;
  /** 關聯 input 的 name/id */
  name: string;
  /** 提示文字 */
  hint?: string;
  /** 是否必填 */
  required?: boolean;
}

/** Input 屬性 */
export interface InputProps {
  /** input 名稱 */
  name: string;
  /** input 類型 */
  type?: string;
  /** 佔位文字 */
  placeholder?: string;
  /** 預設值 */
  value?: string;
  /** 是否必填 */
  required?: boolean;
  /** 是否唯讀 */
  readonly?: boolean;
}

/** Select 選項 */
export interface SelectOption {
  value: string;
  label: string;
}

/** Select 屬性 */
export interface SelectProps {
  name: string;
  options: SelectOption[];
  value?: string;
  required?: boolean;
  placeholder?: string;
}

/**
 * 表單群組 — 包裝 label + input + hint
 */
export const FormGroup: FC<PropsWithChildren<FormGroupProps>> = ({
  label,
  name,
  hint,
  required,
  children,
}) => {
  return (
    <div class="form-group">
      <label for={name}>
        {label}
        {required && <span style="color: var(--danger); margin-left: 2px">*</span>}
      </label>
      {children}
      {hint && <div class="form-hint">{hint}</div>}
    </div>
  );
};

/**
 * 文字輸入元件
 */
export const Input: FC<InputProps> = ({
  name,
  type = 'text',
  placeholder,
  value,
  required,
  readonly,
}) => {
  return (
    <input
      type={type}
      name={name}
      id={name}
      placeholder={placeholder}
      value={value}
      required={required}
      readonly={readonly}
    />
  );
};

/**
 * 下拉選單元件
 */
export const Select: FC<SelectProps> = ({
  name,
  options,
  value,
  required,
  placeholder,
}) => {
  return (
    <select name={name} id={name} required={required}>
      {placeholder && (
        <option value="" disabled selected={!value}>
          {placeholder}
        </option>
      )}
      {options.map((opt) => (
        <option value={opt.value} selected={opt.value === value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
};

export default FormGroup;
