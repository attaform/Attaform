<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const schema = z.object({
    todos: z.array(
      z.object({
        title: z.string().min(1, 'Title is required'),
        done: z.boolean(),
      })
    ),
    dateRange: z.tuple([z.string(), z.string()]),
  })

  const form = useForm({
    schema,
    defaultValues: {
      todos: [
        { title: 'Ship cluster 1', done: true },
        { title: 'Ship cluster 2', done: false },
      ],
      dateRange: ['2026-05-01', '2026-05-31'],
    },
    key: 'docs-demo-arrays-and-tuples',
  })

  function addTodo() {
    form.append('todos', { title: '', done: false })
  }
</script>

<template>
  <form @submit.prevent>
    <fieldset>
      <legend>z.array — variable length</legend>
      <div v-for="(_, i) in form.values.todos" :key="i" class="row">
        <input v-register="form.register(`todos.${i}.title`)" type="text" placeholder="Title" />
        <label class="check">
          <input v-register="form.register(`todos.${i}.done`)" type="checkbox" />
          done
        </label>
        <button type="button" class="ghost" @click="form.remove('todos', i)">−</button>
      </div>
      <button type="button" class="ghost add" @click="addTodo">+ Add todo</button>
    </fieldset>

    <fieldset>
      <legend>z.tuple — fixed length [start, end]</legend>
      <label>
        Start
        <input v-register="form.register('dateRange.0')" type="date" />
      </label>
      <label>
        End
        <input v-register="form.register('dateRange.1')" type="date" />
      </label>
    </fieldset>

    <pre>{{ JSON.stringify(form.values, null, 2) }}</pre>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }
  fieldset {
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
    padding: 0.625rem 0.875rem;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  legend {
    padding: 0 0.375rem;
    font-size: 0.75rem;
    color: #6b7280;
    font-family: ui-monospace, monospace;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .row input[type='text'] {
    flex: 1;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.75rem;
    color: #6b7280;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8125rem;
    color: #374151;
  }
  input[type='text'],
  input[type='date'] {
    padding: 0.375rem 0.5rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.8125rem;
    font-family: inherit;
  }
  input:focus {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
  }
  button.ghost {
    padding: 0.25rem 0.625rem;
    background: white;
    color: #374151;
    border: 1px solid #d1d5db;
    border-radius: 0.375rem;
    font-size: 0.75rem;
    cursor: pointer;
    font-family: inherit;
  }
  button.ghost:hover {
    background: #f9fafb;
  }
  button.add {
    align-self: flex-start;
  }
  pre {
    margin: 0;
    padding: 0.5rem 0.625rem;
    background: #0f172a;
    color: #a5f3fc;
    border-radius: 0.375rem;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    overflow: auto;
  }
</style>
