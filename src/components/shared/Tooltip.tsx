import type { ReactNode } from 'react';

interface TooltipProps {
  text: string;
  children: ReactNode;
  position?: 'top' | 'right' | 'bottom' | 'left';
}

const Tooltip = ({ text, children, position = 'top' }: TooltipProps) => {
  // We use tooltip-wrapper and tooltip-text already defined in index.css
  return (
    <div className="tooltip-wrapper">
      {children}
      <div className={`tooltip-text tooltip-text--${position}`}>
        {text}
      </div>
    </div>
  );
};

export default Tooltip;
