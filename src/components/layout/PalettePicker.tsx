import { Check } from 'lucide-react';
import { PALETTES, setPalette, usePalette } from '../../styles/palette';
import './PalettePicker.css';

export function PalettePicker() {
  const selected = usePalette();
  return <fieldset className="palette-menu">
    <legend>Palette</legend>
    <div className="palette-menu__choices">
      {PALETTES.map(palette => <label key={palette} className="palette-menu__choice">
        <input type="radio" name="palette" value={palette} checked={selected === palette} onChange={() => setPalette(palette)} />
        <span><Check size={14} aria-hidden="true" />{palette === 'default' ? 'Default' : 'Banknote'}</span>
      </label>)}
    </div>
  </fieldset>;
}
