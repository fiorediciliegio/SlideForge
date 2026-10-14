import { Check, Palette, Type, LayoutGrid, Image as ImageIcon, MessageSquareText, ListChecks, ListX } from "lucide-react";
import type { Messages } from "../../i18n/messages";
import type { DesignProfile } from "./types";
import { parseRegionFromRule, ruleTextWithoutRegion } from "./assetRegions";

/**
 * Read-only rendering of a template's structured design profile (4a).
 * Editing lands in Step 4b (ProfileEditor); this panel only displays.
 * Table language: horizontal hairline rows, no verticals, mono tokens —
 * the profile reads as a spec sheet rather than a form.
 */
export function ProfilePanel({ t, profile }: { t: Messages; profile?: DesignProfile | null }) {
  const copy = t.userTemplates;
  if (!profile) {
    return (
      <div className="user-template-profile user-template-profile-empty">
        <Palette size={16} />
        <p>{copy.profileEmpty}</p>
      </div>
    );
  }
  const typography = profile.typography;
  const fontRows = [
    typography?.heading_font ? { role: copy.profileHeadingFont, value: typography.heading_font } : null,
    typography?.body_font ? { role: copy.profileBodyFont, value: typography.body_font } : null,
    typography?.fallback_fonts?.length ? { role: copy.profileFallbackFonts, value: typography.fallback_fonts.join(", ") } : null,
  ].filter((row): row is { role: string; value: string } => Boolean(row));
  return (
    <div className="user-template-profile">
      <h3><Palette size={15} />{copy.profileTitle}</h3>
      <section>
        <h4>{copy.profileColors}</h4>
        <div className="user-template-profile-table" role="table" aria-label={copy.profileColors}>
          <div className="user-template-profile-tr head" role="row">
            <span role="columnheader" />
            <span role="columnheader">{copy.profileColToken}</span>
            <span role="columnheader">{copy.profileColHex}</span>
            <span role="columnheader">{copy.profileColUsage}</span>
          </div>
          {profile.colors.map((color) => (
            <div className="user-template-profile-tr" role="row" key={color.token} title={`${[color.usage, color.source].filter(Boolean).join(" · ")}`}>
              <span role="cell">
                <button
                  type="button"
                  className="user-template-color-swatch"
                  style={{ background: color.hex }}
                  onClick={() => { void navigator.clipboard?.writeText(color.hex); }}
                  aria-label={color.hex}
                />
              </span>
              <span role="cell"><code className="user-template-profile-mono">{color.token}</code></span>
              <span role="cell"><code className="user-template-profile-mono">{color.hex}</code></span>
              <span role="cell" className="user-template-profile-usage">{color.role}{color.usage ? ` — ${color.usage}` : ""}</span>
            </div>
          ))}
        </div>
      </section>
      {fontRows.length || typography?.notes ? (
        <section>
          <h4><Type size={14} />{copy.profileTypography}</h4>
          {fontRows.length ? (
            <div className="user-template-profile-table font-table" role="table" aria-label={copy.profileTypography}>
              <div className="user-template-profile-tr head" role="row">
                <span role="columnheader" />
                <span role="columnheader">{copy.profileColRole}</span>
                <span role="columnheader">{copy.profileColDetail}</span>
              </div>
              {fontRows.map((row) => (
                <div className="user-template-profile-tr" role="row" key={row.role}>
                  <span role="cell" className="user-template-profile-usage">{row.role}</span>
                  <span role="cell">{row.value}</span>
                  <span role="cell" className="user-template-profile-usage">{typography?.notes && row.role === copy.profileBodyFont ? typography.notes : ""}</span>
                </div>
              ))}
            </div>
          ) : null}
          {typography?.notes && !fontRows.length ? <p className="user-template-profile-note">{typography.notes}</p> : null}
        </section>
      ) : null}
      {profile.layout_rules?.length ? (
        <section>
          <h4><LayoutGrid size={14} />{copy.profileLayoutRules}</h4>
          <ol className="user-template-profile-rules">{profile.layout_rules.map((rule, index) => <li key={index}><span className="user-template-profile-index">{index + 1}</span>{rule}</li>)}</ol>
        </section>
      ) : null}
      {profile.fixed_assets?.length ? (
        <section>
          <h4><ImageIcon size={14} />{copy.profileFixedAssets}</h4>
          {profile.fixed_assets.map((asset, index) => {
            const region = parseRegionFromRule(asset.position_rule);
            const ruleText = ruleTextWithoutRegion(asset.position_rule);
            return (
              <div className="user-template-profile-asset" key={index}>
                <strong>
                  {asset.label ?? asset.kind}
                  {region ? <code className="user-template-profile-region-chip">{region}</code> : null}
                </strong>
                {ruleText ? <p>{ruleText}</p> : null}
                {asset.notes ? <p className="user-template-profile-note">{asset.notes}</p> : null}
              </div>
            );
          })}
        </section>
      ) : null}
      {profile.voice ? (
        <section>
          <h4><MessageSquareText size={14} />{copy.profileVoice}</h4>
          <p className="user-template-profile-voice">{profile.voice}</p>
        </section>
      ) : null}
      {profile.do?.length || profile.dont?.length ? (
        <section className="user-template-profile-dodont">
          {profile.do?.length ? (
            <div>
              <h4><ListChecks size={14} />{copy.profileDo}</h4>
              <ul className="user-template-profile-list">{profile.do.map((item, index) => <li key={index}><Check size={12} />{item}</li>)}</ul>
            </div>
          ) : null}
          {profile.dont?.length ? (
            <div>
              <h4><ListX size={14} />{copy.profileDont}</h4>
              <ul className="user-template-profile-list">{profile.dont.map((item, index) => <li key={index}>{item}</li>)}</ul>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
