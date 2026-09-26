// Composants partagés
import { ref, watch, computed } from 'vue';
import { GET, STATUS } from './api.js';

export const Badge = {
  props: ['status', 'label', 'color'],
  computed: {
    info() { return STATUS[this.status] || [this.label || this.status, this.color || 'gray']; },
  },
  template: `<span class="badge" :class="'b-' + (color || info[1])">{{ label || info[0] }}</span>`,
};

export const Modal = {
  props: { title: String, wide: Boolean },
  emits: ['close'],
  template: `
  <div class="modal-bg" @mousedown.self="$emit('close')">
    <div class="modal" :class="{wide}">
      <div class="modal-head"><h3>{{ title }}</h3><button class="icon-btn" @click="$emit('close')">✕</button></div>
      <div class="modal-body"><slot/></div>
      <div class="modal-foot" v-if="$slots.foot"><slot name="foot"/></div>
    </div>
  </div>`,
};

// Champ de recherche avec suggestions (clients, véhicules, articles…)
export const Picker = {
  props: { modelValue: [Number, String], endpoint: String, label: Function, placeholder: String, initial: String, params: String },
  emits: ['update:modelValue', 'pick'],
  setup(props, { emit }) {
    const q = ref(props.initial || '');
    const items = ref([]);
    const open = ref(false);
    const hi = ref(0);
    let timer;
    watch(() => props.initial, (v) => { q.value = v || ''; });
    const search = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        items.value = (await GET(`${props.endpoint}?q=${encodeURIComponent(q.value)}${props.params ? '&' + props.params : ''}`)).slice(0, 12);
        hi.value = 0;
        open.value = true;
      }, 150);
    };
    const pick = (it) => {
      q.value = props.label(it);
      open.value = false;
      emit('update:modelValue', it.id);
      emit('pick', it);
    };
    const key = (e) => {
      if (!open.value) return;
      if (e.key === 'ArrowDown') { hi.value = Math.min(hi.value + 1, items.value.length - 1); e.preventDefault(); }
      if (e.key === 'ArrowUp') { hi.value = Math.max(hi.value - 1, 0); e.preventDefault(); }
      if (e.key === 'Enter' && items.value[hi.value]) { pick(items.value[hi.value]); e.preventDefault(); }
      if (e.key === 'Escape') open.value = false;
    };
    const clear = () => { q.value = ''; emit('update:modelValue', null); emit('pick', null); };
    const blur = () => setTimeout(() => { open.value = false; }, 200);
    return { q, items, open, hi, search, pick, key, clear, blur };
  },
  template: `
  <div class="picker">
    <input v-model="q" :placeholder="placeholder || 'Rechercher…'" @input="search" @focus="search" @keydown="key" @blur="blur">
    <button v-if="q" class="picker-clear" @mousedown.prevent="clear" tabindex="-1">✕</button>
    <div class="picker-list" v-if="open && items.length">
      <div v-for="(it, i) in items" :key="it.id" :class="{hi: i === hi}" @mousedown.prevent="pick(it)">{{ label(it) }}</div>
    </div>
  </div>`,
};

// Petit graphique en barres (CA mensuel)
export const BarChart = {
  props: { data: Array, valueKey: String, labelKey: String, format: Function },
  setup(props) {
    const max = computed(() => Math.max(1, ...props.data.map((d) => Number(d[props.valueKey]) || 0)));
    return { max };
  },
  template: `
  <div class="barchart">
    <div v-for="d in data" :key="d[labelKey]" class="bar-col" :title="format ? format(d[valueKey]) : d[valueKey]">
      <div class="bar-val">{{ format ? format(d[valueKey]) : d[valueKey] }}</div>
      <div class="bar" :style="{height: (100 * (d[valueKey] || 0) / max) + '%'}"></div>
      <div class="bar-lbl">{{ d[labelKey] }}</div>
    </div>
    <div v-if="!data.length" class="muted">Pas encore de données</div>
  </div>`,
};

export const Empty = {
  props: ['icon', 'text'],
  template: `<div class="empty"><div class="empty-icon">{{ icon || '📭' }}</div><div>{{ text }}</div><slot/></div>`,
};

// Icône vectorielle (jeu Lucide servi par /vendor/icons.js)
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
