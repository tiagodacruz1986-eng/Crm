// Icône vectorielle au trait (jeu Lucide servi par /vendor/icons.js). <Icon name="wrench"/> ; class="ti" = à la taille du texte.
import ICONS from '/vendor/icons.js';
import { h } from 'vue';
export const Icon = {
  props: { name: String, size: [Number, String] },
  setup(props) {
    return () => {
      const node = ICONS[props.name];
      if (!node) return null;
      return h('svg', { class: 'icon', xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', width: props.size, height: props.size, 'aria-hidden': 'true' },
        node.map(([tag, attrs]) => h(tag, attrs)));
    };
  },
};
