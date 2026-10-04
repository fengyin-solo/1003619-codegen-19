<template>
  <section class="page" data-module="treegrowth">
    <header class="page-head">
      <div>
        <h2>林木生长管理</h2>
        <p class="page-desc">维护林木生长记录，围绕记录编号、样地编号、林分类型、调查日期、平均胸径做登记、筛选与状态流转。</p>
      </div>
    </header>

    <div class="tab-bar">
      <button
        class="tab-item"
        :class="{ active: tab === 'list' }"
        type="button"
        @click="tab = 'list'"
      >
        记录清单
      </button>
      <button
        class="tab-item"
        :class="{ active: tab === 'review' }"
        type="button"
        @click="tab = 'review'"
      >
        样地复核
      </button>
    </div>

    <GrowthList v-if="tab === 'list'" />
    <PlotReview v-else />
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'

import GrowthList from './growth-list.vue'
import PlotReview from './plot-review.vue'

const tab = ref<'list' | 'review'>('list')
</script>
