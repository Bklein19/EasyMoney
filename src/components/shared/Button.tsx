import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  iconOnly?: boolean;
}

const Button = ({
  children,
  variant = 'primary', // primary, secondary, ghost, danger
  size = 'md', // sm, md, lg
  iconOnly = false,
  className = '',
  disabled = false,
  onClick,
  type = 'button',
  ...props
}: ButtonProps) => {
  const baseClass = 'btn';
  const variantClass = variant ? `btn--${variant}` : '';
  const sizeClass = size !== 'md' ? `btn--${size}` : '';
  const iconClass = iconOnly ? 'btn--icon' : '';

  const classes = [baseClass, variantClass, sizeClass, iconClass, className]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type={type}
      className={classes}
      disabled={disabled}
      onClick={onClick}
      {...props}
    >
      {children}
    </button>
  );
};

export default Button;
