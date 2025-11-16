#!/bin/bash

echo "🔧 Criando estrutura de pastas para o projeto manutencao-reciclagem..."

# Banco de dados
mkdir -p data

# Uploads
mkdir -p uploads/tmp
mkdir -p uploads/equipamentos
mkdir -p uploads/ordens

# Arquivos públicos
mkdir -p public

# Views
mkdir -p views/admin
mkdir -p views/funcionario
mkdir -p views/partials

echo "✅ Estrutura criada com sucesso!"
echo "Pastas:"
echo " - data/"
echo " - uploads/tmp/"
echo " - uploads/equipamentos/"
echo " - uploads/ordens/"
echo " - public/"
echo " - views/admin/"
echo " - views/funcionario/"
echo " - views/partials/"
