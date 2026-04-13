import { defineStore } from 'pinia'
import axios from 'axios'

export const useConfigStore = defineStore('config', {
  state: () => ({
    realms: [],
    system: null,
    isLoaded: false
  }),
  
  getters: {
    realmOrder: (state) => {
      return [...state.realms].sort((a, b) => a.rank - b.rank).map(r => r.name);
    }
  },

  actions: {
    async fetchConfigs() {
      if (this.isLoaded) return;
      
      try {
        const [realmsRes, systemRes] = await Promise.all([
          axios.get('/api/config/data/realms'),
          axios.get('/api/config/data/system')
        ]);
        
        this.realms = realmsRes.data.data.realms || [];
        this.system = systemRes.data.data || {};
        this.isLoaded = true;
      } catch (error) {
        console.error('获取配置失败:', error);
      }
    },
    
    getRealmByName(name) {
      return this.realms.find(r => r.name === name);
    }
  }
})
