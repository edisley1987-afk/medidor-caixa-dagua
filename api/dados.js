export default async function handler(req, res) {
  // Se o método for POST (dados vindo do gateway)
  if (req.method === 'POST') {
    try {
      const body = req.body;
      console.log('Dados recebidos:', body);

      // Envia os dados para o seu webhook no webhook.site
      const response = await fetch(
        'http://webhook.site/fb8edc5b-ddcf-4cff-b2d5-c29b5721c0dd/api/v1_2/json/itg/data',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );

      const result = await response.text();
      console.log('Resposta do webhook:', result);

      return res.status(200).json({ message: 'Dados enviados com sucesso' });
    } catch (error) {
      console.error('Erro ao enviar dados:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  // Se o método for GET (painel requisitando dados)
  if (req.method === 'GET') {
    try {
      // Exemplo de retorno simulado para testes de visualização
      const dadosFake = [
        { caixa: 'Reservatório Elevador', nivel: 82 },
        { caixa: 'Reservatório Osmose', nivel: 61 },
       
